import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A contact sheet for checking a file by eye: frames spread evenly over its length, tiled into
 * one PNG, read left to right and top to bottom. Uses ffmpeg only, so it works on any video.
 * Inspired by the preview check in the FCPXML MCP (MIT). The code here is our own.
 */

export type SheetOptions = { frames?: number; columns?: number; width?: number };

export class SheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetError";
  }
}

/** Start times, in ms, of the frames on the sheet: one per equal slice of the file. Pure. */
export function sheetTimes(durationMs: number, frames: number): number[] {
  const slice = durationMs / frames;
  return Array.from({ length: frames }, (_, i) => Math.round(i * slice));
}

/** The ffmpeg arguments that build the sheet. Pure, so it can be checked without ffmpeg. */
export function sheetArgs(input: string, output: string, durationMs: number, options: SheetOptions = {}): string[] {
  const frames = options.frames ?? 12;
  const columns = options.columns ?? 4;
  const width = options.width ?? 320;
  const rows = Math.ceil(frames / columns);
  // One frame per slice: fps=1/step picks a frame every `step` seconds from the start.
  const step = durationMs / frames / 1000;
  return [
    "-y", "-v", "error", "-i", input,
    "-vf", `fps=1/${step.toFixed(4)},scale=${width}:-2,tile=${columns}x${rows}`,
    "-frames:v", "1", output,
  ];
}

export type SheetResult = { path: string; columns: number; rows: number; timesMs: number[] };

/** Builds the sheet and returns where it is and the time of each frame, in reading order. */
export function buildSheet(input: string, output: string, durationMs: number, options: SheetOptions = {}): SheetResult {
  if (!(durationMs > 0)) {
    throw new SheetError(`The file has no length to sample: ${input}`);
  }
  const frames = options.frames ?? 12;
  const columns = options.columns ?? 4;
  mkdirSync(dirname(output), { recursive: true });
  const result = spawnSync("ffmpeg", sheetArgs(input, output, durationMs, options), { encoding: "utf8", timeout: 5 * 60_000 });
  if (result.status !== 0) {
    throw new SheetError(`ffmpeg could not build the sheet: ${(result.stderr || result.error?.message || "no output").trim().slice(0, 500)}`);
  }
  if (!existsSync(output)) {
    throw new SheetError(`ffmpeg reported success but ${output} does not exist`);
  }
  return {
    path: output,
    columns,
    rows: Math.ceil(frames / columns),
    timesMs: sheetTimes(durationMs, frames),
  };
}

/** <package>/out/sheets/<name>-sheet-<timestamp>.png, next to the renders. */
export function defaultSheetPath(input: string, now: Date = new Date()): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const name = basename(input).replace(/\.[^.]+$/, "");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(resolve(here, "..", "..", "out", "sheets"), `${name}-sheet-${stamp}.png`);
}
