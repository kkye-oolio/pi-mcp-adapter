import { test } from "node:test";
import assert from "node:assert/strict";
import { ownershipKey, validateViewerRequest } from "./request.mjs";

const TOKEN = "synthetic-token-9f8e7d-do-not-log";

function makeRequest(overrides = {}) {
  return {
    version: 1,
    action: "ensure",
    harness: "pi",
    sessionId: "session-abc123",
    serverName: "demo",
    toolName: "app",
    url: `http://127.0.0.1:51234/?session=${TOKEN}`,
    ...overrides,
  };
}

/** Assert the call fails with a fixed message that quotes no input value. */
function assertRejected(value, matcher) {
  let error;
  try {
    validateViewerRequest(value);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof Error, `expected a rejection for ${matcher}`);
  assert.match(error.message, matcher);
  assert.equal(error.message.includes(TOKEN), false, `error quoted a value: ${error.message}`);
  return error;
}

test("accepts localhost, IPv4 and IPv6 viewer URLs and returns them unchanged", () => {
  for (const url of [
    "http://localhost:51234/?session=abc",
    "http://127.0.0.1:51234/?session=abc",
    "http://[::1]:51234/?session=abc",
  ]) {
    const request = makeRequest({ url });
    assert.deepEqual(validateViewerRequest(request), request);
  }
});

test("accepts both actions and both harnesses", () => {
  for (const action of ["ensure", "close"]) {
    for (const harness of ["pi", "claude"]) {
      const request = makeRequest({ action, harness });
      assert.deepEqual(validateViewerRequest(request), request);
    }
  }
});

test("returns a new object containing only the validated fields", () => {
  const input = Object.freeze(makeRequest());
  const result = validateViewerRequest(input);
  assert.notEqual(result, input);
  assert.deepEqual(Object.keys(result), [
    "version",
    "action",
    "harness",
    "sessionId",
    "serverName",
    "toolName",
    "url",
  ]);
  assert.equal(Object.hasOwn(result, "reason"), false);
});

test("rejects values that are not plain objects", () => {
  for (const value of [null, undefined, 1, "ensure", true, [makeRequest()]]) {
    assertRejected(value, /must be a JSON object/);
  }
});

test("rejects unknown, missing and invalid fields", () => {
  const cases = [
    [{ extra: 1 }, /unknown field/],
    [{ ...makeRequest(), extra: 1 }, /unknown field/],
    [{ ...makeRequest(), version: 2 }, /version must be 1/],
    [{ ...makeRequest(), version: "1" }, /version must be 1/],
    [{ ...makeRequest(), action: "open" }, /action must be ensure or close/],
    [{ ...makeRequest(), action: 1 }, /action must be ensure or close/],
    [{ ...makeRequest(), harness: "other" }, /harness must be pi or claude/],
    [{ ...makeRequest(), sessionId: "" }, /sessionId is invalid/],
    [{ ...makeRequest(), sessionId: 42 }, /sessionId is invalid/],
    [{ ...makeRequest(), serverName: "" }, /serverName is invalid/],
    [{ ...makeRequest(), toolName: "" }, /toolName is invalid/],
  ];
  for (const [value, matcher] of cases) assertRejected(value, matcher);

  for (const field of ["version", "action", "harness", "sessionId", "serverName", "toolName", "url"]) {
    const request = makeRequest();
    delete request[field];
    assertRejected(request, /missing a required field/);
  }
});

test("enforces identifier length boundaries and rejects control characters", () => {
  assert.doesNotThrow(() => validateViewerRequest(makeRequest({ sessionId: "s".repeat(128) })));
  assertRejected(makeRequest({ sessionId: "s".repeat(129) }), /sessionId is invalid/);
  for (const field of ["serverName", "toolName"]) {
    assert.doesNotThrow(() => validateViewerRequest(makeRequest({ [field]: "n".repeat(256) })));
    assertRejected(makeRequest({ [field]: "n".repeat(257) }), new RegExp(`${field} is invalid`));
  }
  for (const field of ["sessionId", "serverName", "toolName"]) {
    for (const code of ["\u0000", "\u0007", "\u007f"]) {
      assertRejected(makeRequest({ [field]: `ok${code}bad` }), new RegExp(`${field} is invalid`));
    }
  }
});

test("accepts every close reason and preserves it", () => {
  for (const reason of ["replaced", "completed", "runtime_stopped", "failed"]) {
    const request = makeRequest({ action: "close", reason });
    assert.deepEqual(validateViewerRequest(request), request);
  }
  // A close without a reason is valid; interpretation stays with the controller.
  assert.doesNotThrow(() => validateViewerRequest(makeRequest({ action: "close" })));
});

test("rejects a reason on ensure and any unknown reason", () => {
  for (const reason of ["replaced", "completed", "runtime_stopped", "failed"]) {
    assertRejected(makeRequest({ action: "ensure", reason }), /reason is only valid on close/);
  }
  for (const reason of ["restarted", "REPLACED", "", 1, null, {}, []]) {
    assertRejected(makeRequest({ action: "close", reason }), /reason must be replaced/);
  }
});

test("ownership key ignores the close reason", () => {
  const request = makeRequest({ action: "close" });
  const base = ownershipKey(request, SOCKET);
  for (const reason of ["replaced", "completed", "runtime_stopped", "failed"]) {
    assert.equal(ownershipKey({ ...request, reason }, SOCKET), base);
  }
});

test("rejects remote, non-http, non-local and wrong-path URLs", () => {
  const cases = [
    `https://127.0.0.1:51234/?session=${TOKEN}`,
    `ftp://127.0.0.1:51234/?session=${TOKEN}`,
    `file:///tmp/viewer?session=${TOKEN}`,
    `javascript:alert(1)//?session=${TOKEN}`,
    `http://viewer.example.test:51234/?session=${TOKEN}`,
    `http://127.0.0.2:51234/?session=${TOKEN}`,
    `http://127.0.0.1:51234/app/?session=${TOKEN}`,
    "not a url",
  ];
  for (const url of cases) {
    assert.throws(() => validateViewerRequest(makeRequest({ url })), Error, url);
  }
});

test("rejects an implicit or absent port", () => {
  assertRejected(makeRequest({ url: `http://localhost/?session=${TOKEN}` }), /explicit port/);
  assertRejected(makeRequest({ url: `http://127.0.0.1:80/?session=${TOKEN}` }), /explicit port/);
});

test("rejects userinfo and fragments", () => {
  assertRejected(makeRequest({ url: `http://u@127.0.0.1:51234/?session=${TOKEN}` }), /userinfo/);
  assertRejected(makeRequest({ url: `http://u:p@127.0.0.1:51234/?session=${TOKEN}` }), /userinfo/);
  assertRejected(makeRequest({ url: `http://127.0.0.1:51234/?session=${TOKEN}#frag` }), /fragment/);
  assertRejected(makeRequest({ url: `http://127.0.0.1:51234/#/session/${TOKEN}` }), /path must be \/|fragment/);
});

test("requires exactly one session parameter and no other query parameter", () => {
  const cases = [
    [`http://127.0.0.1:51234/`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?other=1`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?session=abc&other=1`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?other=1&session=abc`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?token=abc`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?`, /exactly one session parameter/],
    [`http://127.0.0.1:51234/?session=${TOKEN}&session=second`, /exactly one session parameter/],
  ];
  for (const [url, matcher] of cases) assertRejected(makeRequest({ url }), matcher);
});

test("requires exactly one nonempty session parameter", () => {
  const cases = [
    [`http://127.0.0.1:51234/?session=`, /session parameter is invalid/],
    [`http://127.0.0.1:51234/?session=%00bad`, /session parameter is invalid/],
  ];
  for (const [url, matcher] of cases) assertRejected(makeRequest({ url }), matcher);

  assert.doesNotThrow(() => validateViewerRequest(makeRequest({ url: `http://127.0.0.1:51234/?session=${"t".repeat(512)}` })));
  assertRejected(makeRequest({ url: `http://127.0.0.1:51234/?session=${"t".repeat(513)}` }), /session parameter is invalid/);
});

test("rejects a URL carrying raw control characters that URL() would strip", () => {
  for (const code of ["\n", "\r", "\t"]) {
    const url = `http://127.0.0.1:51234/?session=${TOKEN}${code}`;
    // URL() accepts these and silently removes them, so a parse-time-only check
    // would pass a URL that is not the string that was validated.
    assert.equal(new URL(url).search, `?session=${TOKEN}`);
    assertRejected(makeRequest({ url }), /control characters/);
  }
  for (const code of ["\n", "\t"]) {
    assertRejected(makeRequest({ url: `http://127.0.0.1:${code}51234/?session=abc` }), /control characters/);
    assertRejected(makeRequest({ url: `http://127.0.0.1:51234/\n?session=abc` }), /control characters/);
  }
  assertRejected(makeRequest({ url: `http://127.0.0.1:51234/?session=a\u0000b` }), /control characters/);
});

test("rejects an over-long url", () => {
  const long = `http://127.0.0.1:51234/?session=${"t".repeat(4200)}`;
  assertRejected(makeRequest({ url: long }), /too long/);
});

const SOCKET = "/tmp/herdr/session-abc123.sock";

test("ownership key is a 64 character lowercase sha-256 hex string", () => {
  assert.match(ownershipKey(makeRequest(), SOCKET), /^[0-9a-f]{64}$/);
});

test("ownership is shared across Apps and URLs of one agent on one socket", () => {
  const base = makeRequest();
  const other = makeRequest({ serverName: "other", toolName: "settings", url: "http://localhost:9999/?session=different" });
  assert.equal(ownershipKey(base, SOCKET), ownershipKey(other, SOCKET));
  assert.equal(ownershipKey(makeRequest({ action: "close" }), SOCKET), ownershipKey(base, SOCKET));
});

test("ownership differs by harness, session and socket", () => {
  const request = makeRequest();
  const base = ownershipKey(request, SOCKET);
  assert.notEqual(ownershipKey(makeRequest({ harness: "claude" }), SOCKET), base);
  assert.notEqual(ownershipKey(makeRequest({ sessionId: "session-other" }), SOCKET), base);
  assert.notEqual(ownershipKey(request, "/tmp/herdr/session-other.sock"), base);
});

test("ownership key rejects a bad request and a bad socket path", () => {
  assert.throws(() => ownershipKey({ ...makeRequest(), version: 2 }, SOCKET), /version must be 1/);
  for (const socketPath of ["", "relative.sock", "/tmp/\u0000bad.sock", 42, null]) {
    let error;
    try {
      ownershipKey(makeRequest(), socketPath);
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error instanceof Error, `expected a socket path rejection for ${String(socketPath)}`);
    assert.match(error.message, /socket path/);
    assert.equal(error.message.includes(TOKEN), false);
  }
});
