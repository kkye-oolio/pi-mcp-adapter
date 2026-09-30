import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Fixed strings. No caller value, URL, token or vendor text is ever interpolated. */
export const ERR = {
  context: "viewer runtime context is unavailable",
  notAbsoluteSocket: "viewer socket path must be absolute",
  receiptMissing: "terminal-browser setup receipt is missing",
  receiptMismatch: "terminal-browser setup receipt does not match this runtime",
  lockHeld: "viewer slot is locked by another operation",
  stateSymlink: "viewer state path is a symlink",
  statePermissions: "viewer state path has unexpected permissions",
  stateForeign: "viewer state directory belongs to another user",
  paneRenamed: "viewer pane is no longer controlled by this session",
  paneRepurposed: "viewer pane is running something other than the owned view",
  paneBusy: "viewer pane is occupied by another process",
  runnerReused: "viewer runner identity no longer matches the owned view",
  viewUnknown: "viewer state is present but the view could not be confirmed",
  runnerExit: "viewer runner exited before the view was ready",
};

export function fail(message) {
  throw new Error(message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function newNonce() {
  return randomBytes(16).toString("hex");
}

export function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The trusted runtime context. Taken from this process environment only: the
 * focused pane is never consulted, so another agent's focus cannot redirect us.
 */
export function readContext(env = process.env) {
  if (env.HERDR_ENV !== "1") fail(ERR.context);
  const paneId = env.HERDR_PANE_ID;
  if (typeof paneId !== "string" || paneId.length === 0) fail(ERR.context);
  const socketPath = env.HERDR_SOCKET_PATH;
  if (typeof socketPath !== "string" || socketPath.length === 0) fail(ERR.context);
  if (!isAbsolute(socketPath)) fail(ERR.notAbsoluteSocket);

  if (typeof env.HOME !== "string" || env.HOME.length === 0 || !isAbsolute(env.HOME)) fail(ERR.context);
  const home = resolve(env.HOME);
  if (home.includes("+")) fail(ERR.context);

  return { paneId, socketPath, home, runtimeRoot: join(home, ".local/share/herdr-visual-surface") };
}

/** The installed namespace. Vendors must see exactly these paths. */
export function namespaceEnv(context) {
  const { home, runtimeRoot } = context;
  const state = join(home, ".local/state/herdr-visual-surface");
  return {
    HOME: home,
    XDG_STATE_HOME: join(state, "xdg-state"),
    XDG_RUNTIME_DIR: join(state, "runtime"),
    XDG_CONFIG_HOME: join(state, "config"),
    XDG_DATA_HOME: join(runtimeRoot, "data"),
    XDG_CACHE_HOME: join(home, "Library/Caches/herdr-visual-surface"),
    TERMINAL_BROWSER_CONFIG_DIR: join(state, "config/terminal-browser"),
    TERMINAL_BROWSER_INTEROP_DIR: join(state, "interop"),
    TERMINAL_BROWSER_APPDATA: join(home, "Library/Application Support/herdr-visual-surface"),
    AGENT_SKILLS_HOME: join(runtimeRoot, "setup-skills"),
  };
}

/** Narrow child environment: namespace, PATH and locale, never inherited creds. */
export function childEnv(context, extra = {}) {
  const env = { ...namespaceEnv(context) };
  for (const key of ["PATH", "LANG", "TERM", "COLORTERM", "TMPDIR"]) {
    if (typeof process.env[key] === "string" && process.env[key].length > 0) env[key] = process.env[key];
  }
  env.HERDR_ENV = "1";
  env.HERDR_PANE_ID = context.paneId;
  env.HERDR_SOCKET_PATH = context.socketPath;
  return { ...env, ...extra };
}

export function vendorBinary(context) {
  return join(context.runtimeRoot, "terminal-browser/bin/terminal-browser");
}

/**
 * Verify the genuine setup receipt written by the vendor installer. Runs before
 * every vendor invocation; this never writes a receipt and never runs setup.
 */
export function verifySetupReceipt(context, fs = defaultFs) {
  const versionFile = join(namespaceEnv(context).XDG_STATE_HOME, "terminal-browser/setup-version");
  let recorded;
  try {
    fs.validateReceiptFile(context, versionFile);
    recorded = fs.readText(versionFile).trim();
  } catch (error) {
    if (error?.code === "ENOENT") fail(ERR.receiptMissing);
    if (error?.message === ERR.receiptMismatch) fail(ERR.receiptMismatch);
    fail(ERR.receiptMissing);
  }
  let version;
  let runtimeRoot;
  try {
    version = fs.readVersionFile(context).trim();
    runtimeRoot = fs.realRuntimeRoot(context);
  } catch {
    fail(ERR.receiptMissing);
  }
  const expected = `${version} ${runtimeRoot}`;
  if (recorded !== expected) fail(ERR.receiptMismatch);
}

const defaultFs = {
  validateReceiptFile(context, path) {
    let current = path;
    let fileInfo;
    for (;;) {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) fail(ERR.receiptMismatch);
      if (current === path) fileInfo = info;
      if (current === context.home || dirname(current) === current) break;
      current = dirname(current);
    }
    if (!fileInfo?.isFile() || fileInfo.uid !== process.getuid()) fail(ERR.receiptMismatch);
  },
  readText(path) {
    return readFileSync(path, "utf8");
  },
  readVersionFile(context) {
    return readFileSync(join(context.runtimeRoot, "terminal-browser/VERSION"), "utf8");
  },
  realRuntimeRoot(context) {
    return realpathSync(join(context.runtimeRoot, "terminal-browser"));
  }
};

/** Redact anything that could carry a capability URL or token. */
export function sanitize(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/https?:\/\/\S+/gi, "[redacted]")
    .replace(/([?&](?:session|token|access_token|code)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * State, permissions and locking
 * ------------------------------------------------------------------ */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const execFileAsync = promisify(execFile);

async function defaultProcessIdentity(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return undefined;
    fail(ERR.lockHeld);
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 4096,
      shell: false,
    });
    const identity = stdout.trim();
    if (identity) return identity;
  } catch {
    fail(ERR.lockHeld);
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return undefined;
  }
  fail(ERR.lockHeld);
}

export function createStore(context, fsImpl = realFs) {
  if (typeof context?.home !== "string" || !isAbsolute(context.home) || context.home.includes("+")) fail(ERR.context);
  const root = join(context.home, ".local/state/herdr-visual-surface/owners");
  return new StateStore(root, fsImpl, context.home);
}

class StateStore {
  constructor(root, fs, home) {
    this.root = root;
    this.fs = fs;
    this.home = home;
  }

  slotDir(slot) {
    if (!/^[0-9a-f]{64}$/.test(slot)) fail("viewer slot must be a sha-256 hex key");
    return join(this.root, slot);
  }

  #ensureDir(path) {
    const info = this.fs.lstat(path);
    if (info.isSymbolicLink()) fail(ERR.stateSymlink);
    if (!info.isDirectory()) fail(ERR.statePermissions);
    if ((info.mode & 0o777) !== DIR_MODE) fail(ERR.statePermissions);
    if (info.uid !== process.getuid()) fail(ERR.stateForeign);
    return info;
  }

  /** Create the dedicated tree, refusing symlinks and loose permissions. */
  ensure() {
    const home = this.home;
    const paths = [
      join(home, ".local"),
      join(home, ".local/state"),
      join(home, ".local/state/herdr-visual-surface"),
      this.root,
    ];
    for (const path of paths) {
      try {
        this.fs.mkdir(path, { mode: DIR_MODE });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const info = this.fs.lstat(path);
      if (info.isSymbolicLink()) fail(ERR.stateSymlink);
      if (!info.isDirectory()) fail(ERR.statePermissions);
      if (path.endsWith("/herdr-visual-surface") || path === this.root) {
        if ((info.mode & 0o777) !== DIR_MODE) fail(ERR.statePermissions);
      }
      if (info.uid !== process.getuid()) fail(ERR.stateForeign);
    }
  }

  ensureSlot(slot) {
    this.ensure();
    const dir = this.slotDir(slot);
    try {
      this.fs.mkdir(dir, { mode: DIR_MODE });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    this.#ensureDir(dir);
    return dir;
  }

  readJson(slot, name, optional = false) {
    const directory = this.slotDir(slot);
    this.#ensureDir(directory);
    const path = join(directory, name);
    let info;
    try {
      info = this.fs.lstat(path);
    } catch (error) {
      if (optional && error?.code === "ENOENT") return undefined;
      throw error;
    }
    if (info.isSymbolicLink()) fail(ERR.stateSymlink);
    if (!info.isFile() || (info.mode & 0o777) !== FILE_MODE) fail(ERR.statePermissions);
    if (info.uid !== process.getuid()) fail(ERR.stateForeign);
    const parsed = JSON.parse(this.fs.readText(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(ERR.statePermissions);
    return parsed;
  }

  readRecordIfPresent(slot) {
    return this.readJson(slot, "state.json", true);
  }

  writeAtomic(slot, name, value) {
    const dir = this.ensureSlot(slot);
    const path = join(dir, name);
    try {
      const existing = this.fs.lstat(path);
      if (existing.isSymbolicLink()) fail(ERR.stateSymlink);
      if (!existing.isFile() || existing.uid !== process.getuid()) fail(ERR.statePermissions);
      if ((existing.mode & 0o777) !== FILE_MODE) fail(ERR.statePermissions);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const temp = join(dir, `.${name}.${process.pid}.tmp`);
    this.fs.writeExclusive(temp, `${JSON.stringify(value, null, 2)}\n`, FILE_MODE);
    this.fs.rename(temp, path);
    this.fs.chmod(path, FILE_MODE);
    return path;
  }

  remove(slot, name) {
    const directory = this.slotDir(slot);
    this.#ensureDir(directory);
    const path = join(directory, name);
    try {
      const info = this.fs.lstat(path);
      if (info.isSymbolicLink()) fail(ERR.stateSymlink);
      if (info.uid !== process.getuid()) fail(ERR.stateForeign);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    this.fs.rm(path, { force: true });
  }

}

const realFs = {
  lstat(path) {
    return lstatSync(path);
  },
  readText(path) {
    return readFileSync(path, "utf8");
  },
  writeExclusive(path, data, mode) {
    const fd = openSync(path, "wx", mode);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  },
  rename(from, to) {
    renameSync(from, to);
  },
  chmod(path, mode) {
    chmodSync(path, mode);
  },
  mkdir(path, options) {
    mkdirSync(path, options);
  },
  rm(path, options) {
    rmSync(path, options);
  },
};

/**
 * Bounded per-slot lock. Only a lock whose recorded process identity is
 * provably dead or reused is reaped; an unknown holder is an explicit failure.
 */
export class SlotLock {
  constructor(store, slot, { waitMs = 2000, pollMs = 25, now = () => Date.now(), pid = process.pid, processIdentity = defaultProcessIdentity } = {}) {
    this.store = store;
    this.slot = slot;
    this.waitMs = waitMs;
    this.pollMs = pollMs;
    this.now = now;
    this.pid = pid;
    this.processIdentity = processIdentity;
    this.held = false;
    this.token = newNonce();
    this.startIdentity = undefined;
  }

  #path() {
    return join(this.store.slotDir(this.slot), "lock");
  }

  async acquire() {
    this.store.ensureSlot(this.slot);
    this.startIdentity = await this.processIdentity(this.pid);
    if (typeof this.startIdentity !== "string" || this.startIdentity.length === 0) fail(ERR.lockHeld);
    const deadline = this.now() + this.waitMs;
    for (;;) {
      try {
        this.store.fs.writeExclusive(this.#path(), JSON.stringify({ pid: this.pid, start: this.startIdentity, at: this.now(), token: this.token }), FILE_MODE);
        this.held = true;
        return;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = this.store.readJson(this.slot, "lock");
        if (!owner || Object.keys(owner).length !== 4 || Object.keys(owner).some(key => !["pid", "start", "at", "token"].includes(key))
          || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.start !== "string" || !owner.start
          || !Number.isFinite(owner.at) || typeof owner.token !== "string" || !/^[0-9a-f]{32}$/.test(owner.token)) fail(ERR.lockHeld);
        const actualStart = await this.processIdentity(owner.pid);
        if (actualStart === undefined || actualStart !== owner.start) {
          const latest = this.store.readJson(this.slot, "lock");
          if (latest.pid !== owner.pid || latest.start !== owner.start || latest.token !== owner.token) fail(ERR.lockHeld);
          this.store.remove(this.slot, "lock");
          continue;
        }
        if (this.now() >= deadline) fail(ERR.lockHeld);
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
      }
    }
  }

  release() {
    if (!this.held) return;
    const held = this.store.readJson(this.slot, "lock");
    if (held.token !== this.token || held.pid !== this.pid || held.start !== this.startIdentity) fail(ERR.lockHeld);
    this.held = false;
    this.store.remove(this.slot, "lock");
  }

  async with(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

