import { connect } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Client for the VEGAS bridge (vegas-bridge/Bridge.cs). The bridge runs inside VEGAS and
 * answers one-line commands on 127.0.0.1. This module only speaks to it; it never edits a
 * project itself.
 */

export const DEFAULT_BRIDGE_PORT = 47802;

export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Where the bridge wrote its per-run token. Overridable for tests. */
export const tokenPath = (): string => {
  if (process.env.VEGAS_MCP_TOKEN_PATH) return process.env.VEGAS_MCP_TOKEN_PATH;
  const base = process.env.APPDATA ?? join(homedir(), ".config");
  return join(base, "vegas-mcp", "bridge-token.txt");
};

export type BridgeOptions = { port?: number; timeoutMs?: number };

/** Sends one command and returns the parsed reply. Throws BridgeError on any failure. */
export function sendBridgeCommand(command: string, options: BridgeOptions = {}): Promise<Record<string, unknown>> {
  const port = options.port ?? Number(process.env.VEGAS_MCP_BRIDGE_PORT ?? DEFAULT_BRIDGE_PORT);
  const timeoutMs = options.timeoutMs ?? 30_000;

  const path = tokenPath();
  if (!existsSync(path)) {
    return Promise.reject(
      new BridgeError("VEGAS bridge is not running. Open the test project in VEGAS and run Tools > Scripting > Bridge."),
    );
  }
  const token = readFileSync(path, "utf-8").trim();

  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let reply = "";
    let settled = false;

    const finish = (error: BridgeError | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };

    socket.setTimeout(timeoutMs, () =>
      finish(new BridgeError(`VEGAS did not answer '${command.split(" ")[0]}' within ${timeoutMs / 1000} s.`)),
    );
    socket.on("connect", () => socket.write(`${token} ${command}\n`));
    socket.on("data", (chunk) => {
      reply += chunk.toString("utf-8");
      const newline = reply.indexOf("\n");
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(reply.slice(0, newline)) as Record<string, unknown>;
        if (parsed.ok === false) {
          finish(new BridgeError(String(parsed.error ?? "VEGAS reported an error")));
        } else {
          finish(null, parsed);
        }
      } catch {
        finish(new BridgeError("VEGAS bridge sent a reply that is not JSON."));
      }
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") {
        finish(new BridgeError("VEGAS bridge is not running. Run Tools > Scripting > Bridge in VEGAS first."));
      } else {
        finish(new BridgeError(`Could not reach the VEGAS bridge: ${error.message}`));
      }
    });
    socket.on("close", () => {
      if (!settled) finish(new BridgeError("VEGAS closed the connection before replying."));
    });
  });
}
