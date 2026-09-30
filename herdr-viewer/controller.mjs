import { ownershipKey, validateViewerRequest } from "./request.mjs";
import { ERR, SlotLock, createStore, fail, newNonce, sha256 } from "./runtime.mjs";

const LABEL_PREFIX = "Herdr App viewer ";
const READY_MS = 5_000;
const POLL_MS = 50;

function requireMethod(ops, name) {
  if (typeof ops?.[name] !== "function") fail("viewer controller operation is unavailable");
  return ops[name].bind(ops);
}

function parsePaneList(value) {
  if (!value || value.type !== "pane_list" || !Array.isArray(value.panes)) {
    fail("Herdr pane list response is invalid");
  }
  for (const pane of value.panes) {
    if (!pane || typeof pane.pane_id !== "string" || typeof pane.terminal_id !== "string" || typeof pane.workspace_id !== "string" || typeof pane.label !== "string") {
      fail("Herdr pane list response is invalid");
    }
  }
  return value.panes;
}

function parseProcessInfo(value) {
  const info = value?.process_info;
  if (!info || typeof info.pane_id !== "string" || !Number.isInteger(info.shell_pid) || !Number.isInteger(info.foreground_process_group_id) || !Array.isArray(info.foreground_processes)) {
    fail("Herdr process information is invalid");
  }
  for (const proc of info.foreground_processes) {
    if (!proc || !Number.isInteger(proc.pid) || typeof proc.name !== "string") fail("Herdr process information is invalid");
    if (proc.argv !== undefined && (!Array.isArray(proc.argv) || proc.argv.some(arg => typeof arg !== "string"))) fail("Herdr process information is invalid");
    if (proc.argv0 !== undefined && typeof proc.argv0 !== "string") fail("Herdr process information is invalid");
    if (proc.cmdline !== undefined && typeof proc.cmdline !== "string") fail("Herdr process information is invalid");
  }
  return info;
}

function validPaneRef(value) {
  const id = candidate => (typeof candidate === "string" && candidate.length > 0) || (Number.isSafeInteger(candidate) && candidate >= 0);
  return value && typeof value === "object" && id(value.tab) && id(value.pane);
}

function parseBrowserList(value) {
  if (!value || !Array.isArray(value.browsers) || !(value.self === null || validPaneRef(value.self))) {
    fail("terminal-browser registration response is invalid");
  }
  for (const browser of value.browsers) {
    if (!browser || typeof browser.key !== "string" || browser.key.length === 0 || !Number.isInteger(browser.pid) || typeof browser.socket !== "string" || !validPaneRef(browser.pane) || !Array.isArray(browser.tabs)) {
      fail("terminal-browser registration response is invalid");
    }
    for (const tab of browser.tabs) {
      if (!tab || typeof tab.url !== "string" || typeof tab.active !== "boolean") {
        fail("terminal-browser registration response is invalid");
      }
    }
  }
  return value.browsers;
}

function samePaneRef(left, right) {
  return left.tab === right.tab && left.pane === right.pane;
}

function ownedBrowser(browsers, self) {
  if (!self) fail(ERR.viewUnknown);
  const matches = browsers.filter(browser => samePaneRef(browser.pane, self));
  if (matches.length > 1) fail(ERR.viewUnknown);
  return matches[0];
}

function processHasAttach(process, pid, slot, nonce, cliPath) {
  if (!process || process.pid !== pid || !Array.isArray(process.argv)) return false;
  return process.argv.length === 5
    && process.argv[1] === cliPath
    && process.argv[2] === "attach"
    && process.argv[3] === slot
    && process.argv[4] === nonce;
}

function validateRecord(record, slot) {
  if (!record || typeof record !== "object" || Array.isArray(record)) fail(ERR.statePermissions);
  const fields = ["slot", "terminalId", "paneId", "label", "nonce", "runnerPid", "runnerStart", "browserKey", "urlHash", "viewState"];
  if (fields.some(key => !Object.hasOwn(record, key)) || Object.keys(record).some(key => !fields.includes(key))) fail(ERR.statePermissions);
  if (record.slot !== slot || !/^[0-9a-f]{64}$/.test(record.slot)) fail(ERR.statePermissions);
  if (!/^[0-9a-f]{32}$/.test(record.nonce)) fail(ERR.statePermissions);
  const inactive = record.viewState === "replaced" || record.viewState === "failed";
  if (!inactive && record.viewState !== "live") fail(ERR.statePermissions);
  if (record.label !== `${LABEL_PREFIX}${slot.slice(0, 12)}`) fail(ERR.statePermissions);
  if (record.viewState === "replaced" ? record.urlHash !== "" : !/^[0-9a-f]{64}$/.test(record.urlHash)) fail(ERR.statePermissions);
  if (inactive) {
    if (record.runnerPid !== 0 || record.runnerStart !== "none" || record.browserKey !== "none") fail(ERR.statePermissions);
  } else if (record.browserKey === "pending" || !Number.isInteger(record.runnerPid) || record.runnerPid <= 1) {
    fail(ERR.statePermissions);
  }
  if (!Number.isInteger(record.runnerPid) || record.runnerPid < 0) fail(ERR.statePermissions);
  for (const key of ["terminalId", "paneId", "label", "nonce", "runnerStart", "browserKey", "urlHash"]) {
    if (typeof record[key] !== "string" || (key !== "urlHash" && record[key].length === 0)) fail(ERR.statePermissions);
  }
  return record;
}

function validateStartingRecord(record, slot) {
  const fields = ["slot", "terminalId", "paneId", "label", "nonce", "runnerPid", "runnerStart", "browserKey", "urlHash", "viewState"];
  const allowed = [...fields, "originalLabelHash"];
  if (!record || typeof record !== "object" || Array.isArray(record)
    || fields.some(key => !Object.hasOwn(record, key))
    || Object.keys(record).some(key => !allowed.includes(key))) fail(ERR.statePermissions);
  if (record.slot !== slot || record.viewState !== "starting" || !/^[0-9a-f]{32}$/.test(record.nonce)) fail(ERR.statePermissions);
  if (record.label !== `${LABEL_PREFIX}${slot.slice(0, 12)}` || !/^[0-9a-f]{64}$/.test(record.urlHash)) fail(ERR.statePermissions);
  if (record.originalLabelHash !== undefined && !/^[0-9a-f]{64}$/.test(record.originalLabelHash)) fail(ERR.statePermissions);
  if (!Number.isInteger(record.runnerPid) || record.runnerPid < 0 || record.runnerPid === 1) fail(ERR.statePermissions);
  if (record.runnerPid === 0) {
    if (record.runnerStart !== "pending" || record.browserKey !== "pending") fail(ERR.statePermissions);
  } else if (typeof record.runnerStart !== "string" || record.runnerStart === "pending" || record.browserKey !== "pending") {
    fail(ERR.statePermissions);
  }
  for (const key of ["terminalId", "paneId"]) {
    if (typeof record[key] !== "string" || record[key].length === 0) fail(ERR.statePermissions);
  }
  return record;
}

function paneShellOnly(info) {
  const procs = info.foreground_processes;
  if (procs.length === 0) return true;
  if (procs.length !== 1 || procs[0]?.pid !== info.shell_pid) return false;
  return typeof procs[0].name === "string" && /^(zsh|bash|sh|fish)$/.test(procs[0].name);
}

/**
 * Create an injected, hermetic controller. Operations are deliberately small
 * wrappers around public Herdr/terminal-browser commands; tests supply fakes.
 *
 * Required ops: listPanes, processInfo, splitPane, renamePane, runPane,
 * closePane, browserList, processStartIdentity, signalProcess, writeLaunch,
 * removeLaunch, cliPath, wait, now, nonce. The store persists only the minimal
 * ownership record; request URL is kept separately in the private launch file.
 */
export function createController({ context, ops, store = createStore(context), lockOptions, readyMs = READY_MS, pollMs = POLL_MS }) {
  const listPanes = requireMethod(ops, "listPanes");
  const processInfo = requireMethod(ops, "processInfo");
  const splitPane = requireMethod(ops, "splitPane");
  const renamePane = requireMethod(ops, "renamePane");
  const runPane = requireMethod(ops, "runPane");
  const closePane = requireMethod(ops, "closePane");
  const browserList = requireMethod(ops, "browserList");
  const processStartIdentity = requireMethod(ops, "processStartIdentity");
  const signalProcess = requireMethod(ops, "signalProcess");
  const writeLaunch = requireMethod(ops, "writeLaunch");
  const removeLaunch = requireMethod(ops, "removeLaunch");
  const wait = ops.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = ops.now ?? (() => Date.now());
  const nonce = ops.nonce ?? newNonce;
  const cliPath = ops.cliPath;
  if (typeof cliPath !== "string" || cliPath.length === 0) fail("viewer controller operation is unavailable");

  function slotFor(request) {
    return ownershipKey(request, context.socketPath);
  }

  function labelFor(slot) {
    return `${LABEL_PREFIX}${slot.slice(0, 12)}`;
  }

  async function findPaneByTerminal(terminalId) {
    const panes = parsePaneList(await listPanes());
    const matches = panes.filter(pane => pane.terminal_id === terminalId);
    if (matches.length > 1) fail("Herdr pane list response is invalid");
    return matches[0];
  }

  async function verify(record) {
    const pane = await findPaneByTerminal(record.terminalId);
    if (!pane) return { kind: "pane-absent" };
    if (pane.label !== record.label || record.label !== labelFor(record.slot)) fail(ERR.paneRenamed);

    const info = parseProcessInfo(await processInfo(pane.pane_id));
    if (info.pane_id !== pane.pane_id) fail("Herdr process information is invalid");
    const processes = info.foreground_processes;
    const runnerProc = processes.find(proc => proc?.pid === record.runnerPid);
    if (!runnerProc) {
      if (paneShellOnly(info)) {
        const listing = await browserList(pane.pane_id);
        const browsers = parseBrowserList(listing);
        const browser = ownedBrowser(browsers, listing.self);
        if (browser) {
          if (browser.key !== record.browserKey) fail(ERR.paneRepurposed);
          if (browser.tabs.length !== 1 || browser.tabs[0].active !== true) fail(ERR.viewUnknown);
          fail(ERR.paneRepurposed);
        }
        return { kind: "view-exited", pane, info };
      }
      fail(ERR.paneBusy);
    }
    if (!processHasAttach(runnerProc, record.runnerPid, record.slot, record.nonce, cliPath)) fail(ERR.runnerReused);
    const actualStart = await processStartIdentity(record.runnerPid);
    if (actualStart !== record.runnerStart) fail(ERR.runnerReused);

    const listing = await browserList(pane.pane_id);
    const browsers = parseBrowserList(listing);
    const browser = ownedBrowser(browsers, listing.self);
    if (!browser) return { kind: "view-exited", pane, info };
    if (browser.key !== record.browserKey) fail(ERR.paneRepurposed);
    if (browser.tabs.length !== 1 || browser.tabs[0].active !== true) fail(ERR.viewUnknown);
    if (sha256(browser.tabs[0].url) !== record.urlHash) fail(ERR.paneRepurposed);
    return { kind: "live", pane, info, browser };
  }

  function writeInactivePane(slot, record, pane, viewState) {
    store.writeAtomic(slot, "state.json", {
      slot,
      terminalId: record.terminalId,
      paneId: pane.pane_id,
      label: labelFor(slot),
      nonce: record.nonce,
      runnerPid: 0,
      runnerStart: "none",
      browserKey: "none",
      urlHash: viewState === "replaced" ? "" : record.urlHash,
      viewState,
    });
  }

  async function waitForRunnerExit(record, pid, startIdentity) {
    const deadline = now() + readyMs;
    while (now() < deadline) {
      const pane = await findPaneByTerminal(record.terminalId);
      if (!pane || pane.label !== record.label) fail(ERR.paneRenamed);
      const info = parseProcessInfo(await processInfo(pane.pane_id));
      const proc = info.foreground_processes.find(item => item.pid === pid);
      if (!proc) {
        const actualStart = await processStartIdentity(pid);
        if (actualStart === startIdentity) fail(ERR.paneBusy);
        if (!paneShellOnly(info)) fail(ERR.paneBusy);
        return pane;
      }
      if (!processHasAttach(proc, pid, record.slot, record.nonce, cliPath)) fail(ERR.runnerReused);
      if (await processStartIdentity(pid) !== startIdentity) fail(ERR.runnerReused);
      await wait(pollMs);
    }
    fail("viewer did not stop before the replacement deadline");
  }

  async function cancelStarting(record, slot) {
    validateStartingRecord(record, slot);
    let pane = await findPaneByTerminal(record.terminalId);
    if (!pane || pane.label !== record.label && (!record.originalLabelHash || sha256(pane.label) !== record.originalLabelHash)) fail(ERR.paneRenamed);
    if (pane.label !== record.label) {
      const info = parseProcessInfo(await processInfo(pane.pane_id));
      if (!paneShellOnly(info)) fail(ERR.paneBusy);
      await renamePane(pane.pane_id, record.label);
      pane = { ...pane, label: record.label };
    }
    const launch = store.readJson(slot, "launch.json", true);
    if (launch) {
      if (launch.kind !== "launch" || launch.nonce !== record.nonce || !launch.request) fail(ERR.statePermissions);
      const request = validateViewerRequest(launch.request);
      if (request.action !== "ensure" || ownershipKey(request, context.socketPath) !== slot || sha256(request.url) !== record.urlHash) fail(ERR.statePermissions);
    }

    let info = parseProcessInfo(await processInfo(pane.pane_id));
    let matches = info.foreground_processes.filter(proc => processHasAttach(proc, proc.pid, slot, record.nonce, cliPath));
    if (matches.length > 1) fail(ERR.viewUnknown);
    if (matches.length === 1) {
      const proc = matches[0];
      if (record.runnerPid > 1 && proc.pid !== record.runnerPid) fail(ERR.runnerReused);
      const firstStart = await processStartIdentity(proc.pid);
      if (!firstStart || (record.runnerPid > 1 && firstStart !== record.runnerStart)) fail(ERR.runnerReused);
      const confirmedPane = await findPaneByTerminal(record.terminalId);
      if (!confirmedPane || confirmedPane.label !== record.label) fail(ERR.paneRenamed);
      pane = confirmedPane;
      info = parseProcessInfo(await processInfo(confirmedPane.pane_id));
      const confirmed = info.foreground_processes.find(item => item.pid === proc.pid);
      if (!processHasAttach(confirmed, proc.pid, slot, record.nonce, cliPath)) fail(ERR.runnerReused);
      if (await processStartIdentity(proc.pid) !== firstStart) fail(ERR.runnerReused);
      await signalProcess(proc.pid, "SIGTERM");
      pane = await waitForRunnerExit({ ...record, runnerPid: proc.pid }, proc.pid, firstStart);
    } else {
      if (record.runnerPid > 1) {
        const actualStart = await processStartIdentity(record.runnerPid);
        if (actualStart === record.runnerStart) fail(ERR.paneBusy);
      }
      if (!paneShellOnly(info)) fail(ERR.paneBusy);
    }

    const latestLaunch = store.readJson(slot, "launch.json", true);
    if (latestLaunch) {
      if (latestLaunch.kind !== "launch" || latestLaunch.nonce !== record.nonce || !latestLaunch.request) fail(ERR.statePermissions);
      const latestRequest = validateViewerRequest(latestLaunch.request);
      if (latestRequest.action !== "ensure" || ownershipKey(latestRequest, context.socketPath) !== slot || sha256(latestRequest.url) !== record.urlHash) fail(ERR.statePermissions);
      // The runner removes this private request immediately before spawning
      // terminal-browser. Its continued presence proves no vendor child started.
      await removeLaunch(slot, record.nonce);
    } else if (record.runnerPid > 1) {
      const listing = await browserList(pane.pane_id);
      const browsers = parseBrowserList(listing);
      const browser = ownedBrowser(browsers, listing.self);
      if (browser) fail(ERR.paneRepurposed);
    }
    store.remove(slot, "state.json");
    return (await findPaneByTerminal(record.terminalId)) ?? fail(ERR.paneRenamed);
  }

  async function launchInPane(slot, pane, request) {
    const launchNonce = nonce();
    const label = labelFor(slot);
    if (typeof pane.label !== "string") fail("Herdr pane split response is invalid");
    const initial = {
      slot,
      terminalId: pane.terminal_id,
      paneId: pane.pane_id,
      label,
      nonce: launchNonce,
      runnerPid: 0,
      runnerStart: "pending",
      browserKey: "pending",
      urlHash: sha256(request.url),
      viewState: "starting",
      originalLabelHash: sha256(pane.label),
    };
    store.writeAtomic(slot, "state.json", initial);
    try {
      if (pane.label !== label) await renamePane(pane.pane_id, label);
      const { originalLabelHash, ...readyState } = initial;
      store.writeAtomic(slot, "state.json", readyState);
      // The URL exists only in this 0600 launch request and in the browser.
      await writeLaunch(slot, launchNonce, request);
      const command = ops.makeAttachCommand
        ? ops.makeAttachCommand(slot, launchNonce)
        : `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} attach ${slot} ${launchNonce}`;
      await runPane(pane.pane_id, command);
    } catch (error) {
      const current = store.readRecordIfPresent(slot);
      if (current?.nonce === launchNonce && current.viewState === "starting") {
        const reusable = await cancelStarting(current, slot);
        writeInactivePane(slot, current, reusable, "failed");
      }
      throw error;
    }

    const deadline = now() + readyMs;
    // The runner publishes its exact pid/start/browser identity into state.
    while (now() < deadline) {
      const record = store.readRecordIfPresent(slot);
      if (record && record.nonce === launchNonce && record.viewState === "live" && record.runnerPid > 1 && record.runnerStart !== "pending" && record.browserKey !== "pending") {
        validateRecord(record, slot);
        const checked = await verify(record);
        if (checked.kind === "live") return record;
        if (checked.kind === "view-exited") fail(ERR.runnerExit);
      }
      if (record && record.nonce === launchNonce && record.viewState === "failed") {
        validateRecord(record, slot);
        await removeLaunch(slot, launchNonce);
        fail(ERR.runnerExit);
      }
      await wait(pollMs);
    }
    const unfinished = store.readRecordIfPresent(slot);
    if (unfinished?.nonce === launchNonce && unfinished.viewState === "starting") {
      const reusable = await cancelStarting(unfinished, slot);
      writeInactivePane(slot, unfinished, reusable, "failed");
    }
    fail(ERR.runnerExit);
  }

  async function createPane(slot) {
    const result = await splitPane({
      callerPaneId: context.paneId,
      direction: "down",
      cwd: context.home,
      noFocus: true,
    });
    if (!result || typeof result.pane_id !== "string" || typeof result.terminal_id !== "string") {
      fail("Herdr pane split response is invalid");
    }
    const panes = parsePaneList(await listPanes());
    const matches = panes.filter(pane => pane.terminal_id === result.terminal_id);
    if (matches.length !== 1 || matches[0].pane_id !== result.pane_id) fail("Herdr pane split response is invalid");
    return matches[0];
  }

  async function ensure(request) {
    const validated = validateViewerRequest(request);
    if (validated.action !== "ensure") fail("viewer ensure requires an ensure request");
    const slot = slotFor(validated);
    return new SlotLock(store, slot, lockOptions).with(async () => {
      let record = store.readRecordIfPresent(slot);
      if (!record) {
        const pane = await createPane(slot);
        record = await launchInPane(slot, pane, validated);
        return { status: "ready", slot };
      }

      if (record.viewState === "starting") {
        validateStartingRecord(record, slot);
        const pane = await cancelStarting(record, slot);
        await launchInPane(slot, pane, validated);
        return { status: "ready", slot };
      }
      validateRecord(record, slot);
      if (record.viewState === "replaced" || record.viewState === "failed") {
        if (record.viewState === "failed") await removeLaunch(slot, record.nonce);
        const pane = await findPaneByTerminal(record.terminalId);
        if (!pane) {
          store.remove(slot, "state.json");
          await removeLaunch(slot, record.nonce);
          const fresh = await createPane(slot);
          await launchInPane(slot, fresh, validated);
          return { status: "ready", slot };
        }
        if (pane.label !== record.label || pane.label !== labelFor(slot)) fail(ERR.paneRenamed);
        const info = parseProcessInfo(await processInfo(pane.pane_id));
        if (!paneShellOnly(info)) fail(ERR.paneBusy);
        await launchInPane(slot, pane, validated);
        return { status: "ready", slot };
      }
      const checked = await verify(record);
      if (checked.kind === "pane-absent") {
        store.remove(slot, "state.json");
        await removeLaunch(slot, record.nonce);
        const pane = await createPane(slot);
        await launchInPane(slot, pane, validated);
        return { status: "ready", slot };
      }
      if (checked.kind === "live" && record.urlHash === sha256(validated.url)) {
        return { status: "ready", slot };
      }
      if (checked.kind === "live") {
        // verify() checked PID, start identity, attach command/nonce and active URL
        // hash. Signal only that owned runner; never process-group/daemon PID.
        await signalProcess(record.runnerPid, "SIGTERM");
        await waitForRunnerExit(record, record.runnerPid, record.runnerStart);
      }

      const pane = await findPaneByTerminal(record.terminalId);
      if (!pane) {
        store.remove(slot, "state.json");
        await removeLaunch(slot, record.nonce);
        const fresh = await createPane(slot);
        await launchInPane(slot, fresh, validated);
        return { status: "ready", slot };
      }
      if (pane.label !== record.label || pane.label !== labelFor(slot)) fail(ERR.paneRenamed);
      const info = parseProcessInfo(await processInfo(pane.pane_id));
      if (info.foreground_processes.length > 0 && !paneShellOnly(info)) fail(ERR.paneBusy);
      await launchInPane(slot, pane, validated);
      return { status: "ready", slot };
    });
  }

  async function close(request) {
    const validated = validateViewerRequest(request);
    if (validated.action !== "close") fail("viewer close requires a close request");
    const slot = slotFor(validated);
    return new SlotLock(store, slot, lockOptions).with(async () => {
      const record = store.readRecordIfPresent(slot);
      if (!record || record.urlHash !== sha256(validated.url)) return { status: "noop", slot };
      if (record.viewState === "starting") {
        validateStartingRecord(record, slot);
        const pane = await cancelStarting(record, slot);
        if (validated.reason === "replaced") {
          writeInactivePane(slot, record, pane, "replaced");
          return { status: "replaced", slot };
        }
        const current = await findPaneByTerminal(record.terminalId);
        if (!current || current.label !== record.label || current.pane_id !== pane.pane_id) fail(ERR.paneRenamed);
        const info = parseProcessInfo(await processInfo(current.pane_id));
        if (!paneShellOnly(info)) fail(ERR.paneBusy);
        writeInactivePane(slot, record, current, "failed");
        await closePane(current.pane_id);
        store.remove(slot, "state.json");
        return { status: "closed", slot };
      }
      validateRecord(record, slot);
      if (record.viewState === "failed") {
        const pane = await findPaneByTerminal(record.terminalId);
        if (!pane) {
          store.remove(slot, "state.json");
          await removeLaunch(slot, record.nonce);
          return { status: "closed", slot };
        }
        if (pane.label !== record.label || pane.label !== labelFor(slot)) fail(ERR.paneRenamed);
        const info = parseProcessInfo(await processInfo(pane.pane_id));
        if (!paneShellOnly(info)) fail(ERR.paneBusy);
        if (validated.reason === "replaced") {
          writeInactivePane(slot, record, pane, "replaced");
          await removeLaunch(slot, record.nonce);
          return { status: "replaced", slot };
        }
        await removeLaunch(slot, record.nonce);
        await closePane(pane.pane_id);
        store.remove(slot, "state.json");
        return { status: "closed", slot };
      }
      const checked = await verify(record);
      if (checked.kind === "pane-absent") {
        store.remove(slot, "state.json");
        await removeLaunch(slot, record.nonce);
        return { status: "noop", slot };
      }
      if (checked.kind === "live") {
        await signalProcess(record.runnerPid, "SIGTERM");
        await waitForRunnerExit(record, record.runnerPid, record.runnerStart);
      }
      const keepPane = validated.reason === "replaced";
      if (!keepPane) {
        const pane = await findPaneByTerminal(record.terminalId);
        if (!pane) {
          store.remove(slot, "state.json");
          await removeLaunch(slot, record.nonce);
          return { status: "closed", slot };
        }
        if (pane.label !== record.label || pane.label !== labelFor(slot)) fail(ERR.paneRenamed);
        const info = parseProcessInfo(await processInfo(pane.pane_id));
        if (info.foreground_processes.length > 0 && !paneShellOnly(info)) fail(ERR.paneBusy);
        await closePane(pane.pane_id);
        store.remove(slot, "state.json");
        await removeLaunch(slot, record.nonce);
      } else {
        const current = store.readRecordIfPresent(slot);
        if (current && current.urlHash === sha256(validated.url)) {
          // Retain only the verified pane identity; a delayed close cannot act
          // on a later App because this record carries no URL identity.
          writeInactivePane(slot, current, checked.pane, "replaced");
        }
        await removeLaunch(slot, record.nonce);
      }
      return { status: keepPane ? "replaced" : "closed", slot };
    });
  }

  return { ensure, close, slotFor };
}
