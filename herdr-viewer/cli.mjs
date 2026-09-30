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

const SAFE_CODES = new Set([
  "context", "request", "input", "slot_lock", "state", "pane_list_command",
  "pane_list_response", "pane_process_info_command", "pane_process_info_response",
  "pane_split_command", "pane_split_response", "pane_rename_command", "pane_run_command",
  "pane_close_command", "browser_receipt", "browser_command", "browser_response",
  "browser_start", "viewer_start", "unknown",
]);

const SAFE_MESSAGES = new Map([
  ["viewer runtime context is unavailable", "context"],
  ["viewer socket path must be absolute", "context"],
  ["viewer slot is locked by another operation", "slot_lock"],
  ["viewer state path is a symlink", "state"],
  ["viewer state path has unexpected permissions", "state"],
  ["viewer state directory belongs to another user", "state"],
  ["Herdr pane list response is invalid", "pane_list_response"],
  ["Herdr process information is invalid", "pane_process_info_response"],
  ["Herdr pane split response is invalid", "pane_split_response"],
  ["terminal-browser setup receipt is missing", "browser_receipt"],
  ["terminal-browser setup receipt does not match this runtime", "browser_receipt"],
  ["terminal-browser view could not be started", "browser_start"],
  ["viewer runner exited before the view was ready", "viewer_start"],
]);

function safeFailure(code = "unknown") {
  const error = new Error("Herdr App viewer operation failed");
  Object.defineProperty(error, "diagnosticCode", { value: SAFE_CODES.has(code) ? code : "unknown" });
  return error;
}

function parseJson(text, message, code) {
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(message);
    if (code && SAFE_CODES.has(code)) Object.defineProperty(error, "diagnosticCode", { value: code });
    throw error;
  }
}

function safeDiagnosticCode(error) {
  if (SAFE_CODES.has(error?.diagnosticCode)) return error.diagnosticCode;
  if (error?.message?.startsWith("viewer request ")) return "request";
  if (error?.message === "viewer request exceeds the input limit" || error?.message === "viewer request is empty") return "input";
  if (error?.message === "terminal-browser response was not valid JSON") return "browser_response";
  if (error?.message === "Herdr response was not valid JSON") return "pane_list_response";
  return SAFE_MESSAGES.get(error?.message) ?? "unknown";
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
    throw safeFailure(options.failureCode);
  }
}

async function herdrJson(args, failureCode) {
  const { stdout } = await runExecutable(HERDR, args, { failureCode });
  const responseCode = failureCode === "pane_split_command" ? "pane_split_response"
    : failureCode === "pane_process_info_command" ? "pane_process_info_response" : "pane_list_response";
  return parseJson(stdout, "Herdr response was not valid JSON", responseCode);
}

function makeOps(context, store) {
  async function vendorJson(args, paneId = context.paneId) {
    verifySetupReceipt(context);
    const { stdout } = await runExecutable(vendorBinary(context), args, {
      cwd: context.home,
      env: childEnv(context, { HERDR_PANE_ID: paneId }),
      timeout: 5_000,
      maxBuffer: 32_768,
      failureCode: "browser_command",
    });
    return parseJson(stdout, "terminal-browser response was not valid JSON", "browser_response");
  }

  return {
    cliPath: CLI_PATH,
    async listPanes() {
      const output = await herdrJson(["pane", "list"], "pane_list_command");
      return output?.result;
    },
    async processInfo(paneId) {
      const output = await herdrJson(["pane", "process-info", "--pane", paneId], "pane_process_info_command");
      return output?.result;
    },
    async splitPane({ callerPaneId, direction, cwd, noFocus }) {
      const args = ["pane", "split", "--pane", callerPaneId, "--direction", direction, "--cwd", cwd];
      if (noFocus) args.push("--no-focus");
      const output = await herdrJson(args, "pane_split_command");
      return output?.result?.pane;
    },
    async renamePane(paneId, label) {
      await runExecutable(HERDR, ["pane", "rename", paneId, label], { failureCode: "pane_rename_command" });
    },
    async runPane(paneId, command) {
      await runExecutable(HERDR, ["pane", "run", paneId, command], { failureCode: "pane_run_command" });
    },
    async closePane(paneId) {
      await runExecutable(HERDR, ["pane", "close", paneId], { failureCode: "pane_close_command" });
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
  const request = validateViewerRequest(parseJson(raw, "viewer request is invalid JSON", "request"));
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
} catch (error) {
  const code = safeDiagnosticCode(error);
  process.stderr.write(`Herdr App viewer operation failed (code=${code})\n`);
  process.exitCode = 1;
}
