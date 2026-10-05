import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One JSON line per tool call in out/actions.log. Written after the fact, so it records what
 * happened, and a logging failure never breaks the tool that was logging.
 */

const here = dirname(fileURLToPath(import.meta.url));
const defaultLogFile = resolve(here, "..", "..", "out", "actions.log");

export type ActionEntry = {
  tool: string;
  ok: boolean;
  /** Short, human-readable outcome. Keep it small: the log is for review, not for replay. */
  summary?: string;
};

export function logAction(entry: ActionEntry, file: string = defaultLogFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", "utf-8");
  } catch {
    // Logging is best effort. The tool result matters more than the log line.
  }
}
