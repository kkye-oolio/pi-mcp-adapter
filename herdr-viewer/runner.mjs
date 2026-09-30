import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ownershipKey, validateViewerRequest } from "./request.mjs";
import { childEnv, fail, sanitize, sha256, vendorBinary, verifySetupReceipt } from "./runtime.mjs";

const execFileAsync = promisify(execFile);
const MAX_STDERR = 16_384;

function fixedFailure() {
  return new Error("terminal-browser view could not be started");
}

function validateInitialRecord(record, slot, nonce) {
  const fields = ["slot", "terminalId", "paneId", "label", "nonce", "runnerPid", "runnerStart", "browserKey", "urlHash", "viewState"];
  if (!record || typeof record !== "object" || Array.isArray(record)) throw fixedFailure();
  if (fields.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !fields.includes(key))) throw fixedFailure();
  if (record.slot !== slot || record.nonce !== nonce || record.viewState !== "starting") throw fixedFailure();
  if (!Number.isInteger(record.runnerPid) || record.runnerPid < 0 || record.runnerPid === 1) throw fixedFailure();
  if (record.runnerPid === 0 && (record.runnerStart !== "pending" || record.browserKey !== "pending")) throw fixedFailure();
  for (const key of ["terminalId", "paneId", "label", "runnerStart", "browserKey"]) {
    if (typeof record[key] !== "string" || record[key].length === 0) throw fixedFailure();
  }
  if (!/^[0-9a-f]{64}$/.test(record.urlHash)) throw fixedFailure();
  return record;
}

async function processStartIdentity(pid) {
  const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 4096,
    shell: false,
  });
  const value = stdout.trim();
  if (!value) throw fixedFailure();
  return value;
}

export function findRegistration(value, urlHash) {
  const validId = candidate => (typeof candidate === "string" && candidate.length > 0) || (Number.isSafeInteger(candidate) && candidate >= 0);
  const validRef = (candidate, self = false) => candidate && typeof candidate === "object"
    && typeof candidate.pane === "string" && candidate.pane.length > 0
    && (self && candidate.tab === undefined || candidate.tab === null || validId(candidate.tab));
  if (!value || !Array.isArray(value.browsers) || !validRef(value.self, true)) throw fixedFailure();
  for (const browser of value.browsers) {
    if (!browser || typeof browser.key !== "string" || browser.key.length === 0 || !Number.isInteger(browser.pid) || typeof browser.socket !== "string" || !validRef(browser.pane) || !Array.isArray(browser.tabs)) throw fixedFailure();
    if (browser.tabs.some(tab => !tab || typeof tab.url !== "string" || typeof tab.active !== "boolean")) throw fixedFailure();
  }
  const { tab, pane } = value.self;
  const sameRef = candidate => candidate.pane === pane && (tab === undefined || tab === null || candidate.tab === tab);
  const owned = value.browsers.filter(browser => sameRef(browser.pane));
  if (owned.length > 1) throw fixedFailure();
  if (owned.length === 0) return undefined;
  const [browser] = owned;
  if (typeof browser.key !== "string" || !Array.isArray(browser.tabs)) throw fixedFailure();
  if (browser.tabs.length !== 1 || browser.tabs[0]?.active !== true || typeof browser.tabs[0].url !== "string") throw fixedFailure();
  if (sha256(browser.tabs[0].url) !== urlHash) throw fixedFailure();
  return browser.key;
}

/** Run inside the owned Herdr pane; URL never appears in its shell command. */
export async function runAttached({ slot, nonce, context, store, ops = {} }) {
  if (!/^[0-9a-f]{64}$/.test(slot) || !/^[0-9a-f]{32}$/.test(nonce)) throw fixedFailure();
  const launch = ops.readLaunch
    ? await ops.readLaunch(slot)
    : store.readJson(slot, "launch.json");
  if (!launch || Object.keys(launch).some(key => !["kind", "nonce", "request"].includes(key)) || launch.kind !== "launch" || launch.nonce !== nonce) throw fixedFailure();
  const request = validateViewerRequest(launch.request);
  if (request.action !== "ensure" || ownershipKey(request, context.socketPath) !== slot) throw fixedFailure();
  const record = validateInitialRecord(store.readRecordIfPresent(slot), slot, nonce);
  if (record.label !== `Herdr App viewer ${slot.slice(0, 12)}` || record.urlHash !== sha256(request.url)) throw fixedFailure();
  if (!Number.isInteger(process.pid) || process.pid <= 1) throw fixedFailure();
  const startIdentity = await (ops.processStartIdentity ?? processStartIdentity)(process.pid);
  const urlHash = sha256(request.url);
  store.writeAtomic(slot, "state.json", {
    ...record,
    runnerPid: process.pid,
    runnerStart: startIdentity,
    browserKey: "pending",
    urlHash,
    viewState: "starting",
  });

  const verifyReceipt = ops.verifySetupReceipt ?? verifySetupReceipt;
  const vendor = ops.vendorBinary ?? vendorBinary(context);
  try {
    verifyReceipt(context);
  } catch {
    store.writeAtomic(slot, "state.json", {
      ...record,
      runnerPid: 0,
      runnerStart: "none",
      browserKey: "none",
      urlHash,
      viewState: "failed",
    });
    if (ops.removeLaunch) await ops.removeLaunch(slot, nonce);
    else store.remove(slot, "launch.json");
    throw fixedFailure();
  }
  if (ops.removeLaunch) await ops.removeLaunch(slot, nonce);
  else store.remove(slot, "launch.json");
  const child = (ops.spawn ?? spawn)(vendor, ["open", request.url, "--no-merge"], {
    cwd: context.home,
    env: childEnv(context, { HERDR_PANE_ID: record.paneId }),
    shell: false,
    stdio: ["inherit", "inherit", "pipe"],
  });

  let stderrSize = 0;
  let stderrText = "";
  let stderrOverflow = false;
  child.stderr?.on("data", chunk => {
    const text = String(chunk);
    stderrSize += Buffer.byteLength(text);
    if (stderrSize > MAX_STDERR) {
      stderrOverflow = true;
      child.kill("SIGTERM");
      return;
    }
    stderrText += text;
    // Keep only a private, bounded, sanitized diagnostic. It is never logged.
    stderrText = sanitize(stderrText);
  });
  let childFailure = false;
  let childExited = false;
  child.once("error", () => { childFailure = true; });
  child.once("exit", () => { childExited = true; });

  let stopping = false;
  const stopChild = () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const onSignal = () => stopChild();
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.once(signal, onSignal);

  const list = ops.browserList ?? (async () => {
    verifyReceipt(context);
    const { stdout } = await execFileAsync(vendor, ["ls", "--all", "--json"], {
      cwd: context.home,
      env: childEnv(context, { HERDR_PANE_ID: record.paneId }),
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16_384,
      shell: false,
    });
    return JSON.parse(stdout);
  });
  const wait = ops.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = (ops.now ?? Date.now)() + (ops.readyMs ?? 5_000);
  let browserKey;
  try {
    while ((ops.now ?? Date.now)() < deadline) {
      if (childFailure || childExited || child.exitCode !== null || child.signalCode !== null) throw fixedFailure();
      browserKey = findRegistration(await list(), urlHash);
      if (browserKey) break;
      await wait(50);
    }
    if (!browserKey) throw fixedFailure();
    const current = store.readRecordIfPresent(slot);
    if (!current || current.nonce !== nonce) throw fixedFailure();
    store.writeAtomic(slot, "state.json", {
      ...current,
      runnerPid: process.pid,
      runnerStart: startIdentity,
      browserKey,
      urlHash,
      viewState: "live",
    });

    if (!childExited && !childFailure) {
      await new Promise(resolve => {
        child.once("error", resolve);
        child.once("exit", resolve);
      });
    }
    // Diagnostics are intentionally discarded after sanitization.
    void stderrText;
    if (stderrOverflow || childFailure || child.signalCode !== null || child.exitCode !== 0) throw fixedFailure();
  } finally {
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) process.removeListener(signal, onSignal);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}
