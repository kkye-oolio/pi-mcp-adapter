import { describe, expect, it, vi } from "vitest";
import { executeCall } from "../proxy-modes.ts";

async function callText(text: string, settings: Record<string, unknown> = {}) {
  const client = { callTool: vi.fn(async () => ({ content: [{ type: "text", text }] })) };
  const state = {
    config: { settings, mcpServers: { demo: { command: "node" } } },
    manager: {
      getConnection: () => ({ status: "connected", client, tools: [], resources: [] }),
      touch() {}, incrementInFlight() {}, decrementInFlight() {}, getRequestOptions() {},
    },
    toolMetadata: new Map([["demo", [{ name: "demo_get", originalName: "get", description: "Get" }]]]),
  } as any;
  const result = await executeCall(state, "demo_get", {});
  return result.content.map((block: { text?: string }) => block.text ?? "").join("");
}

describe("script pipe hint", () => {
  it("points large results at mcpScript only when scripting is on", async () => {
    const large = "x".repeat(10 * 1024);
    expect(await callText(large, { scriptMode: true })).toContain("use mcpScript");
    expect(await callText(large)).not.toContain("mcpScript");
    expect(await callText("short", { scriptMode: true })).not.toContain("mcpScript");
  });
});
