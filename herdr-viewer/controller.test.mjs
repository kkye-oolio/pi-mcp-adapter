import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createController } from "./controller.mjs";
import { childEnv, createStore, namespaceEnv, readContext, SlotLock, sha256, verifySetupReceipt } from "./runtime.mjs";
import { ownershipKey } from "./request.mjs";
import { findRegistration, runAttached } from "./runner.mjs";

const SOCKET = "/tmp/herdr-test.sock";
const CLI = "/private/test/herdr-viewer/cli.mjs";
const BASE = {
  version: 1,
  action: "ensure",
  harness: "pi",
  sessionId: "session-test-123",
  serverName: "demo",
  toolName: "app",
  url: "http://127.0.0.1:51234/?session=synthetic-capability-token",
};

function fixture({ ready = true, waitMs = 1, lockOptions, omitSplitLabel = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "herdr-controller-test-"));
  const context = { home, socketPath: SOCKET, paneId: "caller-pane", runtimeRoot: join(home, ".local/share/herdr-visual-surface") };
  const store = createStore(context);
  let now = 1000;
  let paneSequence = 0;
  let runnerSequence = 0;
  const panes = [];
  const processCalls = [];
  const splitCalls = [];
  const runCalls = [];
  const signals = [];
  const closeCalls = [];
  const focusedPane = "unrelated-focused-pane";
  const browserEntries = new Map();
  const browserPaneByTerminal = new Map();
  const processByPid = new Map();
  let renameCalls = 0;

  const ops = {
    cliPath: CLI,
    makeAttachCommand(slot, nonce) {
      return `'/node with space' '${CLI}' attach ${slot} ${nonce}`;
    },
    async listPanes() {
      return { type: "pane_list", panes: panes.map(p => ({ ...p })) };
    },
    async processInfo(paneId) {
      processCalls.push(paneId);
      const pane = panes.find(p => p.pane_id === paneId);
      if (!pane) throw new Error("unexpected missing fake pane");
      return {
        process_info: {
          pane_id: pane.pane_id,
          shell_pid: 100,
          foreground_process_group_id: 100,
          foreground_processes: pane.foreground_processes ?? [],
        },
      };
    },
    async splitPane(args) {
      splitCalls.push(args);
      paneSequence += 1;
      const pane = {
        pane_id: `workspace-1:p${paneSequence}`,
        terminal_id: `terminal-${paneSequence}`,
        workspace_id: "workspace-1",
        ...(omitSplitLabel ? {} : { label: "" }),
        foreground_processes: [],
      };
      panes.push(pane);
      return { ...pane };
    },
    async renamePane(paneId, label) {
      renameCalls += 1;
      const pane = panes.find(p => p.pane_id === paneId);
      if (!pane) throw new Error("unexpected missing fake pane");
      pane.label = label;
    },
    async runPane(paneId, command) {
      runCalls.push({ paneId, command });
      if (!ready) return;
      const match = command.match(/attach ([0-9a-f]{64}) ([0-9a-f]{32})$/);
      assert.ok(match, "attach command should contain only slot and nonce hex arguments");
      assert.equal(command.includes(BASE.url), false);
      const [, slot, nonce] = match;
      const launch = store.readJson(slot, "launch.json");
      assert.equal(launch.nonce, nonce);
      assert.equal(launch.request.action, "ensure");
      runnerSequence += 1;
      const pid = 400 + runnerSequence;
      const start = `start-${runnerSequence}`;
      const browserKey = `browser-${runnerSequence}`;
      const requestUrl = launch.request.url;
      const record = store.readRecordIfPresent(slot);
      store.writeAtomic(slot, "state.json", {
        ...record,
        runnerPid: pid,
        runnerStart: start,
        browserKey,
        urlHash: sha256(requestUrl),
        viewState: "live",
      });
      const proc = {
        pid,
        name: "node",
        argv: ["/node", CLI, "attach", slot, nonce],
      };
      processByPid.set(pid, { start, proc });
      const pane = panes.find(p => p.pane_id === paneId);
      pane.foreground_processes = [proc];
      const browserPane = { tab: runnerSequence, pane: runnerSequence };
      browserPaneByTerminal.set(pane.terminal_id, browserPane);
      browserEntries.set(browserKey, {
        key: browserKey,
        pid: 700 + runnerSequence,
        socket: `/tmp/browser-${runnerSequence}.sock`,
        pane: browserPane,
        tabs: [{ url: requestUrl, active: true }],
      });
    },
    async closePane(paneId) {
      closeCalls.push(paneId);
      const index = panes.findIndex(p => p.pane_id === paneId);
      if (index >= 0) panes.splice(index, 1);
    },
    async browserList(paneId) {
      const pane = panes.find(p => p.pane_id === paneId);
      const self = pane ? browserPaneByTerminal.get(pane.terminal_id) ?? { tab: 1, pane: 1 } : null;
      return { self, browsers: [...browserEntries.values()].map(b => ({ ...b, tabs: [...b.tabs] })) };
    },
    async processStartIdentity(pid) {
      const entry = processByPid.get(pid);
      return entry?.start;
    },
    async signalProcess(pid, signal) {
      signals.push({ pid, signal });
      const entry = processByPid.get(pid);
      if (entry) {
        processByPid.delete(pid);
        for (const pane of panes) pane.foreground_processes = (pane.foreground_processes ?? []).filter(p => p.pid !== pid);
        for (const [key, browser] of browserEntries) if (browser.pid === 700 + Number(String(pid).slice(-1))) browserEntries.delete(key);
      }
    },
    async writeLaunch(slot, nonce, request) {
      store.writeAtomic(slot, "launch.json", { kind: "launch", nonce, request });
    },
    async removeLaunch(slot, nonce) {
      const current = store.readJson(slot, "launch.json", true);
      if (!current) return;
      if (current.nonce !== nonce) throw new Error("wrong fake nonce");
      store.remove(slot, "launch.json");
    },
    wait: async ms => { now += Math.max(ms, waitMs); },
    now: () => now,
    nonce: () => (++runnerSequence + 1000).toString(16).padStart(32, "0"),
  };

  const controller = createController({
    context,
    ops,
    store,
    readyMs: 20,
    pollMs: 1,
    lockOptions: { waitMs: 0, processIdentity: async pid => pid === process.pid ? "test-controller-start" : undefined, ...lockOptions },
  });
  return {
    controller,
    context,
    store,
    ops,
    panes,
    processByPid,
    browserEntries,
    splitCalls,
    processCalls,
    runCalls,
    signals,
    closeCalls,
    get renameCalls() { return renameCalls; },
    focusedPane,
    setReady(value) { ready = value; },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

async function withFixture(options, fn) {
  const f = fixture(options);
  try {
    await fn(f);
  } finally {
    f.cleanup();
  }
}

function request(url, overrides = {}) {
  return { ...BASE, url, ...overrides };
}

test("runtime context uses the calling pane and builds the fixed namespace under normal HOME", () => {
  const context = readContext({
    HERDR_ENV: "1",
    HERDR_PANE_ID: "source-pane",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_FOCUSED_PANE: "unrelated-focused-pane",
    HOME: "/home/tester",
  });
  assert.equal(context.paneId, "source-pane");
  assert.equal(context.socketPath, "/tmp/herdr.sock");
  assert.equal(namespaceEnv(context).XDG_STATE_HOME, "/home/tester/.local/state/herdr-visual-surface/xdg-state");
  assert.equal(namespaceEnv(context).XDG_RUNTIME_DIR, "/home/tester/.local/state/herdr-visual-surface/runtime");
  assert.equal(namespaceEnv(context).XDG_CONFIG_HOME, "/home/tester/.local/state/herdr-visual-surface/config");
  assert.equal(namespaceEnv(context).XDG_DATA_HOME, "/home/tester/.local/share/herdr-visual-surface/data");
  assert.equal(namespaceEnv(context).XDG_CACHE_HOME, "/home/tester/Library/Caches/herdr-visual-surface");
  assert.equal(namespaceEnv(context).TERMINAL_BROWSER_CONFIG_DIR, "/home/tester/.local/state/herdr-visual-surface/config/terminal-browser");
  assert.equal(namespaceEnv(context).TERMINAL_BROWSER_INTEROP_DIR, "/home/tester/.local/state/herdr-visual-surface/interop");
  assert.equal(namespaceEnv(context).TERMINAL_BROWSER_APPDATA, "/home/tester/Library/Application Support/herdr-visual-surface");
  assert.equal(namespaceEnv(context).AGENT_SKILLS_HOME, "/home/tester/.local/share/herdr-visual-surface/setup-skills");
  assert.throws(() => readContext({ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "relative", HOME: "/home/tester" }), /absolute/);
  assert.throws(() => readContext({ HERDR_ENV: "0", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/tmp/s", HOME: "/home/tester" }), /context/);

  const key = "HERDR_VIEWER_TEST_UNRELATED";
  const previous = process.env[key];
  process.env[key] = "must-not-forward";
  try {
    const env = childEnv(context);
    assert.equal(env.HOME, "/home/tester");
    assert.equal(env.HERDR_PANE_ID, "source-pane");
    assert.equal(Object.hasOwn(env, key), false);
    assert.equal(Object.hasOwn(env, "TERM_PROGRAM"), false);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("first ensure creates a no-focus pane from the caller and never puts the URL in the shell command", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 1);
    assert.deepEqual(f.splitCalls[0], {
      callerPaneId: "caller-pane",
      direction: "down",
      cwd: f.context.home,
      noFocus: true,
    });
    assert.notEqual(f.splitCalls[0].callerPaneId, f.focusedPane);
    assert.equal(f.runCalls.length, 1);
    assert.equal(f.runCalls[0].command.includes(BASE.url), false);
    assert.match(f.runCalls[0].command, /attach [0-9a-f]{64} [0-9a-f]{32}$/);
    const slot = f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1];
    const statePath = join(f.store.slotDir(slot), "state.json");
    const launchPath = join(f.store.slotDir(slot), "launch.json");
    assert.equal((lstatSync(f.store.slotDir(slot)).mode & 0o777), 0o700);
    assert.equal((lstatSync(statePath).mode & 0o777), 0o600);
    assert.equal((lstatSync(launchPath).mode & 0o777), 0o600);
    const stateText = f.store.fs.readText(statePath);
    assert.equal(stateText.includes(BASE.url), false);
    assert.equal(stateText.includes("synthetic-capability-token"), false);
    assert.equal(f.store.readJson(slot, "launch.json").request.url, BASE.url);
    assert.equal(f.closeCalls.length, 0);
  });
});

test("a native pane list may omit label before the returned split is explicitly renamed", async () => {
  await withFixture({ omitSplitLabel: true }, async f => {
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.renameCalls, 1);
    assert.equal(f.panes[0].label, `Herdr App viewer ${f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1].slice(0, 12)}`);
    assert.equal(f.runCalls.length, 1);
  });
});

test("same URL ensure is idempotent for a verified live view", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.runCalls.length, 1);
    assert.equal(f.signals.length, 0);
  });
});

test("different URL stops the verified runner and reuses the same pane", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const paneId = f.panes[0].pane_id;
    const terminalId = f.panes[0].terminal_id;
    const oldRecord = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    await f.controller.ensure(request("http://localhost:51235/?session=next-token"));
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.panes[0].pane_id, paneId);
    assert.equal(f.panes[0].terminal_id, terminalId);
    assert.deepEqual(f.signals, [{ pid: oldRecord.runnerPid, signal: "SIGTERM" }]);
    assert.equal(f.runCalls.length, 2);
  });
});

test("an exited view is reused when its controlled pane is still at the shell", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const slot = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]).slot;
    const record = f.store.readRecordIfPresent(slot);
    f.processByPid.delete(record.runnerPid);
    f.panes[0].foreground_processes = [];
    f.browserEntries.delete(record.browserKey);

    await f.controller.ensure(request("http://localhost:51235/?session=next-token"));
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.runCalls.length, 2);
    assert.equal(f.signals.length, 0);
  });
});

test("a pane absent from the complete pane list is recreated", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    f.panes.splice(0, 1);
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 2);
    assert.equal(f.panes.length, 1);
    assert.equal(f.runCalls.length, 2);
  });
});

test("a moved pane is found by terminal_id rather than its stored pane_id", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const terminalId = f.panes[0].terminal_id;
    f.panes[0].pane_id = "workspace-2:p9";
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.processCalls.at(-1), "workspace-2:p9");
    assert.equal(f.panes[0].terminal_id, terminalId);
  });
});

test("refuses PID reuse or an attach command with a different nonce before signalling", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    f.panes[0].foreground_processes[0].argv[3] = "wrong-slot";
    await assert.rejects(f.controller.ensure(BASE), /runner identity/);
    assert.equal(f.signals.length, 0);
  });
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const record = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    f.processByPid.get(record.runnerPid).start = "reused-start";
    await assert.rejects(f.controller.ensure(BASE), /runner identity/);
    assert.equal(f.signals.length, 0);
  });
});

test("refuses renamed, repurposed and navigated panes without signalling them", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    f.panes[0].label = "human renamed this";
    await assert.rejects(f.controller.ensure(BASE), /no longer controlled/);
    assert.equal(f.signals.length, 0);
  });
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    f.panes[0].foreground_processes = [{ pid: 888, name: "python", argv: ["python", "other.py"] }];
    await assert.rejects(f.controller.ensure(BASE), /occupied by another process/);
    assert.equal(f.signals.length, 0);
  });
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const record = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    f.browserEntries.get(record.browserKey).tabs[0].url = "http://127.0.0.1:51234/?session=human-navigation";
    await assert.rejects(f.controller.ensure(BASE), /running something other than the owned view/);
    assert.equal(f.signals.length, 0);
  });
});

test("does not adopt another pane's matching URL or a multi-tab owned browser", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const record = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    f.browserEntries.delete(record.browserKey);
    f.browserEntries.set("other-pane-browser", {
      key: "other-pane-browser",
      pid: 999,
      socket: "/tmp/other-browser.sock",
      pane: { tab: 9, pane: 9 },
      tabs: [{ url: BASE.url, active: true }],
    });
    await assert.rejects(f.controller.ensure(BASE), /occupied by another process/);
    assert.equal(f.signals.length, 0);
  });
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const record = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    f.browserEntries.get(record.browserKey).tabs.push({ url: "http://example.test/", active: false });
    await assert.rejects(f.controller.ensure(BASE), /could not be confirmed/);
    assert.equal(f.signals.length, 0);
  });
});

test("runner registration is selected only from its own browser pane", () => {
  const url = BASE.url;
  const hash = sha256(url);
  const other = {
    self: { tab: 1, pane: 1 },
    browsers: [{ key: "other", pid: 2, socket: "/tmp/other.sock", pane: { tab: 2, pane: 2 }, tabs: [{ url, active: true }] }],
  };
  assert.equal(findRegistration(other, hash), undefined);
  const own = {
    self: { tab: 1, pane: 1 },
    browsers: [{ key: "owned", pid: 1, socket: "/tmp/owned.sock", pane: { tab: 1, pane: 1 }, tabs: [{ url, active: true }] }],
  };
  assert.equal(findRegistration(own, hash), "owned");
  assert.throws(() => findRegistration({ ...own, browsers: [{ ...own.browsers[0], tabs: [...own.browsers[0].tabs, { url, active: false }] }] }, hash));
});

test("empty browser tabs are unknown, not proof that an owned view exited", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const record = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]);
    f.processByPid.delete(record.runnerPid);
    f.panes[0].foreground_processes = [];
    f.browserEntries.get(record.browserKey).tabs = [];
    await assert.rejects(f.controller.ensure(request("http://localhost:51235/?session=next-token")), /could not be confirmed/);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.signals.length, 0);
  });
});

test("a stale close for an old URL cannot touch a replacement App", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const originalPid = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]).runnerPid;
    const next = request("http://localhost:51235/?session=next-token");
    await f.controller.ensure(next);
    const result = await f.controller.close({ ...BASE, action: "close" });
    assert.equal(result.status, "noop");
    assert.equal(f.signals.length, 1);
    assert.equal(f.signals[0].pid, originalPid);
    assert.equal(f.closeCalls.length, 0);
    assert.equal(f.panes.length, 1);
  });
});

test("replacement close retains the owned pane and next ensure reuses it", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const terminalId = f.panes[0].terminal_id;
    const result = await f.controller.close({ ...BASE, action: "close", reason: "replaced" });
    assert.equal(result.status, "replaced");
    assert.equal(f.closeCalls.length, 0);
    assert.equal(f.panes.length, 1);
    const slot = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]).slot;
    assert.equal(f.store.readRecordIfPresent(slot).viewState, "replaced");

    await f.controller.ensure(request("http://localhost:51235/?session=next-token"));
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.panes[0].terminal_id, terminalId);
    assert.equal(f.runCalls.length, 2);
  });
});

test("final close reasons and an omitted reason dispose only the owned pane", async () => {
  for (const reason of [undefined, "completed", "runtime_stopped", "failed"]) {
    await withFixture({}, async f => {
      await f.controller.ensure(BASE);
      const paneId = f.panes[0].pane_id;
      const closeRequest = { ...BASE, action: "close", ...(reason === undefined ? {} : { reason }) };
      const result = await f.controller.close(closeRequest);
      assert.equal(result.status, "closed");
      assert.deepEqual(f.closeCalls, [paneId]);
      assert.equal(f.panes.length, 0);
      assert.equal(f.signals.length, 1);
    });
  }
});

test("readiness timeout fails without inventing a runner identity", async () => {
  await withFixture({ ready: false }, async f => {
    await assert.rejects(f.controller.ensure(BASE), /exited before the view was ready/);
    assert.equal(f.runCalls.length, 1);
    const slot = f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1];
    const record = f.store.readRecordIfPresent(slot);
    assert.equal(record.viewState, "failed");
    assert.equal(record.urlHash, sha256(BASE.url));
    assert.equal(record.runnerPid, 0);
    assert.equal(record.runnerStart, "none");
    assert.equal(record.browserKey, "none");
    f.setReady(true);
    await f.controller.ensure(BASE);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.runCalls.length, 2);
  });
});

test("a held lock fails boundedly and is never removed as stale", async () => {
  await withFixture({}, async f => {
    const slot = "a".repeat(64);
    f.store.ensureSlot(slot);
    f.store.fs.writeExclusive(join(f.store.slotDir(slot), "lock"), JSON.stringify({ pid: 999, start: "existing-start", at: 1, token: "c".repeat(32) }), 0o600);
    const lock = new SlotLock(f.store, slot, {
      waitMs: 0,
      pid: process.pid,
      processIdentity: async pid => pid === 999 ? "existing-start" : "test-controller-start",
    });
    await assert.rejects(lock.acquire(), /locked by another operation/);
    assert.equal(f.store.readJson(slot, "lock").pid, 999);
  });
});

test("a controller interrupted in starting state cancels only its nonce-owned runner and reuses the pane", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const slot = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]).slot;
    const record = f.store.readRecordIfPresent(slot);
    f.store.writeAtomic(slot, "state.json", { ...record, viewState: "starting", browserKey: "pending" });

    await f.controller.ensure(request("http://localhost:51235/?session=recovered-token"));
    assert.equal(f.signals.length, 1);
    assert.equal(f.signals[0].pid, record.runnerPid);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.runCalls.length, 2);
    assert.equal(f.store.readRecordIfPresent(slot).viewState, "live");
  });
});

test("an interrupted pane rename is recovered only when its prior label hash matches", async () => {
  await withFixture({}, async f => {
    await f.controller.ensure(BASE);
    const slot = f.store.readRecordIfPresent(f.runCalls[0].command.match(/attach ([0-9a-f]{64})/)[1]).slot;
    const live = f.store.readRecordIfPresent(slot);
    f.processByPid.delete(live.runnerPid);
    f.browserEntries.delete(live.browserKey);
    f.panes[0].foreground_processes = [];
    f.panes[0].label = "";
    f.store.remove(slot, "launch.json");
    f.store.writeAtomic(slot, "state.json", {
      ...live,
      paneId: f.panes[0].pane_id,
      nonce: "a".repeat(32),
      runnerPid: 0,
      runnerStart: "pending",
      browserKey: "pending",
      viewState: "starting",
      originalLabelHash: sha256(""),
    });

    await f.controller.ensure(request("http://localhost:51235/?session=rename-recovery"));
    assert.equal(f.panes[0].label, live.label);
    assert.equal(f.splitCalls.length, 1);
    assert.equal(f.runCalls.length, 2);
  });
});

test("a lock from a proven dead controller is reaped and replaced by this owner", async () => {
  await withFixture({}, async f => {
    const slot = "d".repeat(64);
    f.store.ensureSlot(slot);
    f.store.fs.writeExclusive(join(f.store.slotDir(slot), "lock"), JSON.stringify({ pid: 999, start: "dead-start", at: 1, token: "e".repeat(32) }), 0o600);
    const lock = new SlotLock(f.store, slot, {
      waitMs: 0,
      pid: process.pid,
      processIdentity: async pid => pid === 999 ? undefined : "test-controller-start",
    });
    await lock.acquire();
    assert.equal(f.store.readJson(slot, "lock").pid, process.pid);
    lock.release();
    assert.equal(f.store.readJson(slot, "lock", true), undefined);
  });
});

test("a lock release refuses to remove a replacement holder's lock", async () => {
  await withFixture({}, async f => {
    const slot = "f".repeat(64);
    const lock = new SlotLock(f.store, slot, {
      waitMs: 0,
      pid: process.pid,
      processIdentity: async () => "test-controller-start",
    });
    await lock.acquire();
    const own = f.store.readJson(slot, "lock");
    f.store.remove(slot, "lock");
    f.store.fs.writeExclusive(join(f.store.slotDir(slot), "lock"), JSON.stringify({ ...own, token: "9".repeat(32) }), 0o600);
    assert.throws(() => lock.release(), /locked by another operation/);
    assert.equal(f.store.readJson(slot, "lock").token, "9".repeat(32));
  });
});

test("a missing setup receipt fails before the runner invokes the vendor", async () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-runner-receipt-test-"));
  try {
    const context = { home, socketPath: SOCKET, paneId: "owned-pane", runtimeRoot: join(home, ".local/share/herdr-visual-surface") };
    const store = createStore(context);
    const requestValue = { ...BASE, url: "http://localhost:51234/?session=runner-token" };
    const slot = ownershipKey(requestValue, context.socketPath);
    const nonce = "b".repeat(32);
    store.writeAtomic(slot, "launch.json", { kind: "launch", nonce, request: requestValue });
    store.writeAtomic(slot, "state.json", {
      slot,
      terminalId: "terminal-1",
      paneId: "owned-pane",
      label: `Herdr App viewer ${slot.slice(0, 12)}`,
      nonce,
      runnerPid: 0,
      runnerStart: "pending",
      browserKey: "pending",
      urlHash: sha256(requestValue.url),
      viewState: "starting",
    });
    let vendorCalls = 0;
    await assert.rejects(runAttached({
      slot,
      nonce,
      context,
      store,
      ops: {
        processStartIdentity: async () => "runner-start",
        verifySetupReceipt: () => { throw new Error("receipt missing"); },
        spawn: () => { vendorCalls += 1; throw new Error("must not invoke"); },
      },
    }), /view could not be started/);
    assert.equal(vendorCalls, 0);
    assert.equal(store.readJson(slot, "launch.json", true), undefined);
    const failed = store.readRecordIfPresent(slot);
    assert.equal(failed.viewState, "failed");
    assert.equal(failed.runnerPid, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup receipt must identify the physical terminal-browser root", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-receipt-test-"));
  try {
    const context = { home, runtimeRoot: join(home, ".local/share/herdr-visual-surface") };
    const terminalRoot = join(context.runtimeRoot, "terminal-browser");
    const receipt = join(home, ".local/state/herdr-visual-surface/xdg-state/terminal-browser/setup-version");
    mkdirSync(terminalRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".local/state/herdr-visual-surface/xdg-state/terminal-browser"), { recursive: true, mode: 0o700 });
    writeFileSync(join(terminalRoot, "VERSION"), "2.4.0\n", { mode: 0o600 });
    const physical = realpathSync(terminalRoot);
    writeFileSync(receipt, `2.4.0 ${physical}\n`, { mode: 0o600 });
    assert.doesNotThrow(() => verifySetupReceipt(context));
    writeFileSync(receipt, `2.4.0 ${context.runtimeRoot}\n`, { mode: 0o600 });
    assert.throws(() => verifySetupReceipt(context), /does not match/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("setup receipt verification fails closed for missing and mismatched receipts", () => {
  const context = { home: "/home/test", runtimeRoot: "/home/test/.local/share/herdr-visual-surface" };
  const receiptPath = "/home/test/.local/state/herdr-visual-surface/xdg-state/terminal-browser/setup-version";
  const fake = {
    validateReceiptFile: () => undefined,
    readText: path => {
      assert.equal(path, receiptPath);
      return "2.4.0 /private/runtime/terminal-browser";
    },
    readVersionFile: () => "2.4.0\n",
    realRuntimeRoot: () => "/private/runtime/terminal-browser",
  };
  assert.doesNotThrow(() => verifySetupReceipt(context, fake));
  assert.throws(() => verifySetupReceipt(context, { ...fake, readText: () => { throw new Error("missing"); } }), /receipt is missing/);
  assert.throws(() => verifySetupReceipt(context, { ...fake, readText: () => "other" }), /does not match/);
});
