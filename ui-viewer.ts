import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

export interface UiViewerRequest {
  version: 1;
  action: "ensure" | "close";
  harness: "pi";
  sessionId: string;
  serverName: string;
  toolName: string;
  url: string;
  reason?: "replaced" | "completed" | "runtime_stopped" | "failed";
}

function viewerAbortError(): Error {
  const error = new Error("MCP App viewer launch cancelled");
  error.name = "AbortError";
  return error;
}

/** Invoke a session-owned App viewer with private JSON on stdin. Rejects on launch failure or cancellation. */
export async function invokeUiViewer(
  command: string,
  request: UiViewerRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (!isAbsolute(command)) throw new Error("MCP App viewer command must be an absolute executable path");
  if (options.signal?.aborted) throw viewerAbortError();
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("MCP App viewer timeout must be positive and finite");

  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, [], {
      encoding: "utf8",
      timeout,
      maxBuffer: 16_384,
      signal: options.signal,
      shell: false,
    }, (error) => {
      if (options.signal?.aborted || error?.name === "AbortError") {
        reject(viewerAbortError());
      } else if (error) {
        reject(new Error("MCP App viewer launcher failed"));
      } else {
        resolve();
      }
    });

    if (!child.stdin) {
      child.kill();
      reject(new Error("MCP App viewer stdin unavailable"));
      return;
    }
    child.stdin.once("error", () => {
      child.kill();
      reject(new Error("MCP App viewer request could not be delivered"));
    });
    child.stdin.end(JSON.stringify(request));
  });
}
