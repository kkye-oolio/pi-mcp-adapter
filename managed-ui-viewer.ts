import type { McpExtensionState } from "./state.ts";
import type { UiServerHandle } from "./types.ts";
import { throwIfAborted } from "./abort.ts";
import { invokeUiViewer, type UiViewerRequest } from "./ui-viewer.ts";

interface ManagedViewer {
  ensure(signal: AbortSignal): Promise<void>;
  close(reason?: UiViewerRequest["reason"]): Promise<void>;
}

const managedViewers = new WeakMap<UiServerHandle, ManagedViewer>();

function createManagedViewer(state: McpExtensionState, handle: UiServerHandle, command: string): ManagedViewer {
  const sessionId = state.sessionManager?.getSessionId();
  if (!sessionId) throw new Error("MCP App viewer requires a session identity");
  const request: UiViewerRequest = {
    version: 1,
    action: "ensure",
    harness: "pi",
    sessionId,
    serverName: handle.serverName,
    toolName: handle.toolName,
    url: handle.url,
  };
  let closePromise: Promise<void> | undefined;
  const viewer: ManagedViewer = {
    ensure: async (signal) => {
      if (closePromise) throw new Error("MCP App viewer is closing");
      handle.windowOpen = false;
      try {
        await invokeUiViewer(command, request, { signal });
        throwIfAborted(signal);
        if (state.uiServer !== handle) throw new Error("MCP UI session closed during viewer reconciliation");
        handle.windowOpen = true;
      } catch (error) {
        handle.close("viewer_failed");
        throw error;
      }
    },
    close: (reason = "runtime_stopped") => {
      closePromise ??= invokeUiViewer(command, { ...request, action: "close", reason });
      return closePromise;
    },
  };
  managedViewers.set(handle, viewer);
  state.owner.addCleanup(viewer.close);
  return viewer;
}

/** Returns false when no managed viewer is configured; otherwise ensures the owned view or rejects. */
export async function openManagedUiViewer(state: McpExtensionState, handle: UiServerHandle, signal: AbortSignal): Promise<boolean> {
  const command = state.config.settings?.uiViewerCommand;
  if (!command) return false;
  handle.viewer = "managed";
  try {
    await createManagedViewer(state, handle, command).ensure(signal);
    return true;
  } catch (error) {
    handle.close("viewer_failed");
    throw error;
  }
}

export async function reconcileManagedUiViewer(handle: UiServerHandle, signal: AbortSignal): Promise<void> {
  await managedViewers.get(handle)?.ensure(signal);
}

export function closeManagedUiViewer(state: McpExtensionState, handle: UiServerHandle, reason: string): void {
  const viewer = managedViewers.get(handle);
  if (!viewer) return;
  const closeReason = reason === "replaced" ? "replaced"
    : reason === "runtime_owner_stopped" ? "runtime_stopped"
      : reason === "viewer_failed" ? "failed" : "completed";
  void viewer.close(closeReason).catch(() => {
    state.ui?.notify("MCP App viewer cleanup failed", "warning");
  });
}
