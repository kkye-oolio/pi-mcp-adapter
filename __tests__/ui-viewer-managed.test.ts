import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRuntimeOwner } from "../runtime-owner.ts";
import { maybeStartUiSession, summarizeUiSessionResult } from "../ui-session.ts";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(async () => {}),
  start: vi.fn(),
  glimpse: vi.fn(() => true),
}));
vi.mock("../ui-viewer.ts", () => ({ invokeUiViewer: mocks.launch }));
vi.mock("../ui-server.ts", () => ({ startUiServer: mocks.start }));
vi.mock("../glimpse-ui.ts", () => ({ isGlimpseAvailable: mocks.glimpse, openGlimpseWindow: vi.fn() }));

function setup() {
  const handles: any[] = [];
  const callbacks: any[] = [];
  mocks.start.mockImplementation(async (options: any) => {
    let closed = false;
    const handle = {
      serverName: options.serverName,
      toolName: options.toolName,
      url: `http://localhost:3000/?session=private-token-${handles.length}`,
      sendToolInput: vi.fn(),
      sendToolResult: vi.fn(),
      sendResultPatch: vi.fn(),
      sendToolCancelled: vi.fn(),
      getSessionMessages: () => ({ prompts: [], intents: [], notifications: [], contexts: [] }),
      getStreamSummary: () => undefined,
      close: vi.fn((reason: string) => {
        if (closed) return;
        closed = true;
        options.onComplete(reason);
      }),
    };
    handles.push(handle);
    callbacks.push(options);
    return handle;
  });
  const state = {
    owner: createMcpRuntimeOwner(),
    sessionManager: { getSessionId: vi.fn(() => "caller-session") },
    config: { settings: { uiViewerCommand: "/private/viewer command" }, mcpServers: {} },
    uiResourceHandler: { readUiResource: vi.fn(async () => ({ html: "<main>App</main>" })) },
    manager: { removeResourceUpdatedListener: vi.fn() },
    consentManager: {},
    uiServer: null,
    completedUiSessions: [],
    openBrowser: vi.fn(),
    sendMessage: vi.fn(),
    ui: { notify: vi.fn() },
  } as any;
  return { state, handles, callbacks };
}
const request = { serverName: "demo", toolName: "chart", toolArgs: { value: 1 }, uiResourceUri: "ui://chart" };

afterEach(() => {
  vi.clearAllMocks();
  mocks.launch.mockReset().mockResolvedValue(undefined);
  delete process.env.MCP_UI_VIEWER;
});

describe("managed App viewer", () => {
  it("uses the App-only launcher and never detects Glimpse or calls BROWSER", async () => {
    const { state, handles } = setup();
    const runtime = await maybeStartUiSession(state, request);
    expect(runtime).toMatchObject({ viewer: "managed", windowOpen: true });
    expect(mocks.launch).toHaveBeenCalledWith("/private/viewer command", {
      version: 1, action: "ensure", harness: "pi", sessionId: "caller-session",
      serverName: "demo", toolName: "chart", url: handles[0].url,
    }, { signal: expect.any(AbortSignal) });
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(mocks.glimpse).not.toHaveBeenCalled();
    expect(JSON.stringify(summarizeUiSessionResult(runtime))).not.toContain("private-token");
    await state.owner.stop();
  });

  it("reconciles the same viewer before returning a reused session", async () => {
    const { state, handles } = setup();
    await maybeStartUiSession(state, request);
    const repeated = await maybeStartUiSession(state, { ...request, toolArgs: { value: 2 } });
    expect(repeated).toMatchObject({ reused: true, windowOpen: true });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.launch).toHaveBeenCalledTimes(2);
    expect(mocks.launch.mock.calls[0]?.[1]).toEqual(mocks.launch.mock.calls[1]?.[1]);
    expect(handles[0].sendToolInput).toHaveBeenCalledWith({ value: 2 });
    await state.owner.stop();
  });

  it("closes a replaced App by its captured identity without closing the new App", async () => {
    const { state, handles } = setup();
    await maybeStartUiSession(state, request);
    const changed = await maybeStartUiSession(state, { ...request, toolName: "other" });
    expect(changed).toMatchObject({ reused: false, viewer: "managed" });
    expect(mocks.launch).toHaveBeenCalledWith("/private/viewer command", expect.objectContaining({
      action: "close", toolName: "chart", url: handles[0].url,
    }));
    expect(mocks.launch).toHaveBeenCalledWith("/private/viewer command", expect.objectContaining({
      action: "ensure", toolName: "other", url: handles[1].url,
    }), expect.anything());
    await state.owner.stop();
  });

  it("settles cleanup once and retains the original caller identity", async () => {
    const { state } = setup();
    const runtime = await maybeStartUiSession(state, request);
    state.sessionManager.getSessionId.mockReturnValue("different-session");
    runtime?.close("test");
    await state.owner.stop();
    const closes = mocks.launch.mock.calls.filter((call: any[]) => call[1].action === "close");
    expect(closes).toHaveLength(1);
    expect(closes[0]?.[1]).toMatchObject({ sessionId: "caller-session" });
  });

  it("does not report success or fall back after launch failure", async () => {
    const { state, handles } = setup();
    mocks.launch.mockRejectedValueOnce(new Error("MCP App viewer launcher failed"));
    expect(await maybeStartUiSession(state, request)).toBeNull();
    expect(handles[0].close).toHaveBeenCalledWith("viewer_failed");
    expect(state.uiServer).toBeNull();
    expect(state.openBrowser).not.toHaveBeenCalled();
    expect(mocks.glimpse).not.toHaveBeenCalled();
    await state.owner.stop();
  });

  it("closes the hosted App if trusted session identity is unavailable", async () => {
    const { state, handles } = setup();
    state.sessionManager = undefined;
    expect(await maybeStartUiSession(state, request)).toBeNull();
    expect(handles[0].close).toHaveBeenCalledWith("viewer_failed");
    expect(mocks.launch).not.toHaveBeenCalled();
    await state.owner.stop();
  });

  it("retains explicit window suppression", async () => {
    process.env.MCP_UI_VIEWER = "none";
    const { state } = setup();
    const runtime = await maybeStartUiSession(state, request);
    expect(runtime).toMatchObject({ viewer: "suppressed", windowOpen: false });
    expect(mocks.launch).not.toHaveBeenCalled();
    runtime?.close("test");
    await state.owner.stop();
  });

  it("marks prompts, intents and context as App-originated, not human authority", async () => {
    const { state, callbacks } = setup();
    await maybeStartUiSession(state, request);
    callbacks[0].onMessage({ prompt: "hello", type: "prompt" });
    callbacks[0].onMessage({ type: "intent", intent: "select", params: { id: "one" } });
    callbacks[0].onContextUpdate({ content: [{ type: "text", text: "selection" }] });
    expect(state.sendMessage).toHaveBeenCalledTimes(3);
    for (const [message, options] of state.sendMessage.mock.calls) {
      expect(message.content[0].text).toContain("App-originated");
      expect(message.content[0].text).toContain("not human authorization");
      expect(message.content[0].text).not.toMatch(/^User /);
      expect(message.details).toMatchObject({ server: "demo", tool: "chart" });
      expect(options).toEqual({ triggerTurn: true });
    }
    await state.owner.stop();
  });
});
