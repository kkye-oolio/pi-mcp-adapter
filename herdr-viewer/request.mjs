import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

const FIELDS = ["version", "action", "harness", "sessionId", "serverName", "toolName", "url"];
const OPTIONAL_FIELDS = ["reason"];
const REASONS = new Set(["replaced", "completed", "runtime_stopped", "failed"]);
const ACTIONS = new Set(["ensure", "close"]);
const HARNESSES = new Set(["pi", "claude"]);
const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const MAX_SESSION_ID = 128;
const MAX_NAME = 256;
const MAX_URL = 4096;
const MAX_TOKEN = 512;

// ASCII controls, checked on raw input: URL() silently strips TAB, LF and CR,
// which would otherwise let a control-bearing URL through as a clean string.
const CONTROL = /[\u0000-\u001F\u007F]/;

function fail(message) {
  throw new Error(message);
}

function requirePlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("viewer request must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!FIELDS.includes(key) && !OPTIONAL_FIELDS.includes(key)) fail("viewer request contains an unknown field");
  }
  for (const key of FIELDS) {
    if (!Object.hasOwn(value, key)) fail("viewer request is missing a required field");
  }
}

function requireVersion(value) {
  if (value !== 1) fail("viewer request version must be 1");
  return 1;
}

function requireEnum(value, allowed, message) {
  if (typeof value !== "string" || !allowed.has(value)) fail(message);
  return value;
}

function requireName(value, max, message) {
  if (typeof value !== "string" || value.length === 0) fail(message);
  if (value.length > max) fail(message);
  if (CONTROL.test(value)) fail(message);
  return value;
}

function requireUrl(value) {
  if (typeof value !== "string" || value.length === 0) fail("viewer request url must be a string");
  if (value.length > MAX_URL) fail("viewer request url is too long");
  if (CONTROL.test(value)) fail("viewer request url must not contain control characters");

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("viewer request url must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:") fail("viewer request url must use http");
  if (!HOSTS.has(parsed.hostname)) fail("viewer request url host must be localhost, 127.0.0.1 or [::1]");
  if (!parsed.port) fail("viewer request url must carry an explicit port");
  if (parsed.pathname !== "/") fail("viewer request url path must be /");
  if (parsed.username !== "" || parsed.password !== "") fail("viewer request url must not carry userinfo");
  if (parsed.hash !== "") fail("viewer request url must not carry a fragment");

  const keys = [...parsed.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "session") {
    fail("viewer request url must carry exactly one session parameter");
  }
  const [session] = parsed.searchParams.getAll("session");
  if (session.length === 0 || session.length > MAX_TOKEN || CONTROL.test(session)) {
    fail("viewer request session parameter is invalid");
  }

  return value;
}

/**
 * Why a close was requested. `replaced` keeps the owned pane for another App;
 * the other reasons dispose the owned view and pane, not the Pi runtime.
 */
function requireReason(value, action) {
  if (value === undefined) return undefined;
  if (action !== "close") fail("viewer request reason is only valid on close");
  if (typeof value !== "string" || !REASONS.has(value)) {
    fail("viewer request reason must be replaced, completed, runtime_stopped or failed");
  }
  return value;
}

/**
 * Validate a parsed viewer request and return a new object holding only the
 * accepted fields. Every failure message is fixed and quotes no input value.
 */
export function validateViewerRequest(value) {
  requirePlainObject(value);
  const action = requireEnum(value.action, ACTIONS, "viewer request action must be ensure or close");
  const reason = requireReason(value.reason, action);
  return {
    version: requireVersion(value.version),
    action,
    harness: requireEnum(value.harness, HARNESSES, "viewer request harness must be pi or claude"),
    sessionId: requireName(value.sessionId, MAX_SESSION_ID, "viewer request sessionId is invalid"),
    serverName: requireName(value.serverName, MAX_NAME, "viewer request serverName is invalid"),
    toolName: requireName(value.toolName, MAX_NAME, "viewer request toolName is invalid"),
    url: requireUrl(value.url),
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * Stable key for the pane one agent owns on one Herdr server. Derived only from
 * harness, session and socket path, so several Apps of one agent share a pane.
 */
export function ownershipKey(request, socketPath) {
  const validated = validateViewerRequest(request);
  if (typeof socketPath !== "string" || socketPath.length === 0 || CONTROL.test(socketPath)) {
    fail("viewer socket path must be a nonempty string");
  }
  if (!isAbsolute(socketPath)) fail("viewer socket path must be absolute");

  return createHash("sha256")
    .update(JSON.stringify([validated.harness, validated.sessionId, socketPath]))
    .digest("hex");
}
