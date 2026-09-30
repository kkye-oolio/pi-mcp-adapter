import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { invokeUiViewer, type UiViewerRequest } from "../ui-viewer.ts";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
  default: { execFile: execFileMock },
}));

const VIEWER = "/Applications/Herdr Viewer.app/Contents/MacOS/Herdr Viewer";
const SYNTHETIC_URL = "https://viewer.example.test/session/abc123";
const SYNTHETIC_TOKEN = "synthetic-token-do-not-log-9f8e7d";
const SYNTHETIC_STDOUT = `stdout ${SYNTHETIC_URL}`;
const SYNTHETIC_STDERR = `stderr ${SYNTHETIC_TOKEN}`;

const baseRequest = (overrides: Partial<UiViewerRequest> = {}): UiViewerRequest => ({
  version: 1,
  action: "ensure",
  harness: "pi",
  sessionId: "session-abc123",
  serverName: "demo",
  toolName: "app",
  url: SYNTHETIC_URL,
  ...overrides,
});

interface FakeChild {
  child: any;
  callback: (error: Error | null, stdout?: string, stderr?: string) => void;
  stdinText(): string;
  stdinEnded(): boolean;
  endCount(): number;
}

/** Build the (execFile, callback, child) trio a real invocation would produce. */
function installFakeChild(options: { epipe?: boolean } = {}): FakeChild {
  const chunks: string[] = [];
  let callback!: (error: Error | null, stdout?: string, stderr?: string) => void;

  const stdin = new Writable({
    write(chunk, _encoding, next) {
      if (options.epipe) {
        const error = new Error("write EPIPE synthetic");
        (error as NodeJS.ErrnoException).code = "EPIPE";
        next(error);
        return;
      }
      chunks.push(String(chunk));
      next();
    },
    final(next) {
      next();
    },
  });

  const endSpy = vi.spyOn(stdin, "end");

  const child = {
    pid: 4242,
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      return true;
    }),
    stdin,
  };

  execFileMock.mockImplementation((...args: any[]) => {
    callback = args[args.length - 1];
    return child;
  });

  return {
    child,
    callback: (error, stdout, stderr) => callback(error, stdout, stderr),
    stdinText: () => chunks.join(""),
    stdinEnded: () => stdin.writableEnded,
    // `end()` is called once; a real stream skips _final when the write fails.
    endCount: () => endSpy.mock.calls.length,
  };
}

function execArgsOf(call = 0): { command: unknown; args: unknown[]; options: any } {
  const [command, args, options] = execFileMock.mock.calls[call];
  return { command, args: (args ?? []) as unknown[], options };
}

function errno(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Await a rejection and return the sanitized error, or fail if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  const settled = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(settled, "expected a rejection").toBeInstanceOf(Error);
  return settled as Error;
}

function expectNoLeaks(error: Error, ...forbidden: string[]): void {
  const text = `${error.name} ${error.message} ${error.stack ?? ""}`;
  for (const value of forbidden) {
    expect(text, `error leaked ${value.slice(0, 12)}...`).not.toContain(value);
  }
}

beforeEach(() => {
  execFileMock.mockReset();
  installFakeChild();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("invokeUiViewer", () => {
  it("passes the absolute executable literally with no shell and no arguments", async () => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, baseRequest());
    fake.callback(null);
    await pending;

    const { command, args, options } = execArgsOf();
    expect(command).toBe(VIEWER);
    expect(args).toEqual([]);
    expect(options.shell).toBe(false);
  });

  it("writes the exact request as one JSON value on stdin and ends it", async () => {
    const fake = installFakeChild();
    const request = baseRequest();

    const pending = invokeUiViewer(VIEWER, request);
    expect(fake.stdinEnded()).toBe(true);
    expect(JSON.parse(fake.stdinText())).toEqual(request);

    const callText = JSON.stringify(execArgsOf().command) + JSON.stringify(execArgsOf().args);
    expect(callText).not.toContain(SYNTHETIC_URL);
    expect(callText).not.toContain(SYNTHETIC_TOKEN);

    fake.callback(null);
    await pending;
  });

  it.each([
    ["ensure", baseRequest({ action: "ensure" })],
    ["close", baseRequest({ action: "close" })],
    ["close/replaced", baseRequest({ action: "close", reason: "replaced" })],
    ["close/runtime_stopped", baseRequest({ action: "close", reason: "runtime_stopped" })],
  ] as const)("serializes a %s request unchanged", async (_name, request) => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, request);
    expect(JSON.parse(fake.stdinText())).toEqual(request);

    fake.callback(null);
    await pending;
  });

  it("resolves on zero exit without exposing child output", async () => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, baseRequest());
    fake.callback(null, SYNTHETIC_STDOUT, SYNTHETIC_STDERR);

    await expect(pending).resolves.toBeUndefined();
  });

  it("rejects a relative executable before spawning", async () => {
    await expect(invokeUiViewer("./herdr-viewer", baseRequest())).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted signal without spawning", async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await rejectionOf(invokeUiViewer(VIEWER, baseRequest(), { signal: controller.signal }));
    expect(error.name).toBe("AbortError");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects with AbortError when the signal aborts during launch", async () => {
    const fake = installFakeChild();
    const controller = new AbortController();

    const pending = invokeUiViewer(VIEWER, baseRequest(), { signal: controller.signal });
    expect(execArgsOf().options.signal).toBe(controller.signal);

    controller.abort();
    fake.callback(Object.assign(new Error("aborted"), { name: "AbortError" }));

    const error = await rejectionOf(pending);
    expect(error.name).toBe("AbortError");
  });

  it.each([
    ["nonzero exit", (fake: FakeChild) => fake.callback(errno("Command failed", "1"), SYNTHETIC_STDOUT, SYNTHETIC_STDERR)],
    ["missing executable", (fake: FakeChild) => fake.callback(errno(`spawn ${VIEWER} ENOENT ${SYNTHETIC_TOKEN}`, "ENOENT"))],
    ["signal kill", (fake: FakeChild) => fake.callback(errno("killed", "SIGTERM"), SYNTHETIC_STDOUT, SYNTHETIC_STDERR)],
    [
      "output buffer overflow",
      (fake: FakeChild) => fake.callback(errno(`stdout maxBuffer ${SYNTHETIC_URL}`, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")),
    ],
  ])("rejects a %s without leaking output, raw child error or the url/token", async (_name, fail) => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, baseRequest());
    fail(fake);

    const error = await rejectionOf(pending);
    expectNoLeaks(error, SYNTHETIC_URL, SYNTHETIC_TOKEN, SYNTHETIC_STDOUT, SYNTHETIC_STDERR);
  });

  it("rejects when the supplied timeout elapses", async () => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, baseRequest(), { timeoutMs: 20 });
    expect(execArgsOf().options.timeout).toBe(20);
    fake.callback(errno(`Command failed: ETIMEDOUT ${SYNTHETIC_URL}`, "ETIMEDOUT"), SYNTHETIC_STDOUT, SYNTHETIC_STDERR);

    const error = await rejectionOf(pending);
    expectNoLeaks(error, SYNTHETIC_URL, SYNTHETIC_TOKEN);
  });

  it("rejects on a stdin EPIPE failure, kills the child and stays settled", async () => {
    const fake = installFakeChild({ epipe: true });

    const pending = invokeUiViewer(VIEWER, baseRequest(), { timeoutMs: 5_000 });
    const error = await rejectionOf(pending);
    expect(fake.child.kill).toHaveBeenCalled();

    // A later child callback must not change the settled outcome.
    fake.callback(null);
    await expect(pending).rejects.toBe(error);
    expect(fake.endCount()).toBe(1);
  });

  it("passes the default timeout, max buffer and signal to the child process", async () => {
    const fake = installFakeChild();
    const controller = new AbortController();

    const pending = invokeUiViewer(VIEWER, baseRequest(), { signal: controller.signal });
    const { options } = execArgsOf();
    expect(options.timeout).toBe(10_000);
    expect(options.maxBuffer).toBe(16_384);
    expect(options.signal).toBe(controller.signal);

    fake.callback(null);
    await pending;
  });

  it("passes an explicitly supplied timeout and leaves the max buffer default", async () => {
    const fake = installFakeChild();

    const pending = invokeUiViewer(VIEWER, baseRequest(), { timeoutMs: 250 });
    expect(execArgsOf().options.timeout).toBe(250);
    expect(execArgsOf().options.maxBuffer).toBe(16_384);
    expect(execArgsOf().options.signal).toBeUndefined();

    fake.callback(null);
    await pending;
  });

  it("rejects a non-positive or non-finite timeout before spawning", async () => {
    for (const timeoutMs of [0, -1, Number.NaN]) {
      await expect(invokeUiViewer(VIEWER, baseRequest(), { timeoutMs })).rejects.toThrow();
    }
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
