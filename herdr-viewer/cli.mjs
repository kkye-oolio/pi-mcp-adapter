#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { validateViewerRequest } from "./request.mjs";
import { createController } from "./controller.mjs";
import { runAttached } from "./runner.mjs";
import { createStore, fail, readContext, childEnv, vendorBinary, verifySetupReceipt } from "./runtime.mjs";

const execFileAsync = promisify(execFile);
const MAX_STDIN = 8192;
const HERDR = "herdr";
const CLI_PATH = resolve(process.argv[1]);

function safeFailure() {
  return new Error("Herdr App viewer operation failed");
}

function parseJson(text, message) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(message);
  }
}

async function runExecutable(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: options.timeout ?? 10_000,
      maxBuffer: options.maxBuffer ?? 65_536,
      shell: false,
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    return result;
  } catch {
    // Raw child errors and stderr can contain capability URLs or identifiers.
    throw safeFailure();
  }
}

async function herdrJson(args) {
  const { stdout } = await runExecutable(HERDR, args);
  return parseJson(stdout, "Herdr response was not valid JSON");
}

function makeOps(context, store) {
  async function vendorJson(args, paneId = context.paneId) {
    verifySetupReceipt(context);
    const { stdout } = await runExecutable(vendorBinary(context), args, {
      cwd: context.home,
      env: childEnv(context, { HERDR_PANE_ID: paneId }),
      timeout: 5_000,
      maxBuffer: 32_768,
    });
    return parseJson(stdout, "terminal-browser response was not valid JSON");
  }

  return {
    cliPath: CLI_PATH,
    async listPanes() {
      const output = await herdrJson(["pane", "list"]);
      return output?.result;
    },
    async processInfo(paneId) {
      const output = await herdrJson(["pane", "process-info", "--pane", paneId]);
      return output?.result;
    },
    async splitPane({ callerPaneId, direction, cwd, noFocus }) {
      const args = ["pane", "split", "--pane", callerPaneId, "--direction", direction, "--cwd", cwd];
      if (noFocus) args.push("--no-focus");
      const output = await herdrJson(args);
      return output?.result?.pane;
    },
    async renamePane(paneId, label) {
      await runExecutable(HERDR, ["pane", "rename", paneId, label]);
    },
    async runPane(paneId, command) {
      await runExecutable(HERDR, ["pane", "run", paneId, command]);
    },
    async closePane(paneId) {
      await runExecutable(HERDR, ["pane", "close", paneId]);
    },
    async browserList(paneId) {
      return vendorJson(["ls", "--all", "--json"], paneId ?? context.paneId);
    },
    async processStartIdentity(pid) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return undefined;
        fail("viewer runner identity could not be verified");
      }
      let stdout;
      try {
        ({ stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
          encoding: "utf8",
          timeout: 2_000,
          maxBuffer: 4096,
          shell: false,
        }));
      } catch {
        fail("viewer runner identity could not be verified");
      }
      const value = stdout.trim();
      if (value) return value;
      try {
        process.kill(pid, 0);
      } catch (error) {
        if (error?.code === "ESRCH") return undefined;
      }
      fail("viewer runner identity could not be verified");
    },
    async signalProcess(pid, signal) {
      if (signal !== "SIGTERM" || !Number.isInteger(pid) || pid <= 0) fail("viewer runner identity could not be verified");
      try {
        process.kill(pid, signal);
      } catch {
        throw new Error("viewer runner identity could not be verified");
      }
    },
    async writeLaunch(slot, nonce, request) {
      store.writeAtomic(slot, "launch.json", { kind: "launch", nonce, request });
    },
    async removeLaunch(slot, expectedNonce) {
      const launch = store.readJson(slot, "launch.json", true);
      if (!launch) return;
      if (expectedNonce && launch.nonce !== expectedNonce) fail("viewer launch request ownership changed");
      store.remove(slot, "launch.json");
    },
  };
}

async function readStdin(limit = MAX_STDIN) {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) fail("viewer request exceeds the input limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main() {
  const args = process.argv.slice(2);
  const context = readContext();
  const store = createStore(context);
  if (args.length > 0) {
    if (args.length !== 3 || args[0] !== "attach" || !/^[0-9a-f]{64}$/.test(args[1]) || !/^[0-9a-f]{32}$/.test(args[2])) {
      fail("viewer attach arguments are invalid");
    }
    await runAttached({ slot: args[1], nonce: args[2], context, store });
    return;
  }

  const raw = await readStdin();
  if (raw.length === 0) fail("viewer request is empty");
  const request = validateViewerRequest(parseJson(raw, "viewer request is invalid JSON"));
  const ops = makeOps(context, store);
  // Keep the shell string constant except for hex slot/nonce identifiers. Never
  // interpolate a URL, app name, session id or vendor-provided field.
  ops.makeAttachCommand = (slot, nonce) => `${shellQuote(process.execPath)} ${shellQuote(CLI_PATH)} attach ${slot} ${nonce}`;
  const controller = createController({ context, ops, store });
  if (request.action === "ensure") await controller.ensure(request);
  else await controller.close(request);
}

try {
  await main();
} catch {
  process.stderr.write("Herdr App viewer operation failed\n");
  process.exitCode = 1;
}
