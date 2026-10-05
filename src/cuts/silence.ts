import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { CutRange } from "./detect.js";

/**
 * Silences measured in the audio itself, with ffmpeg's silencedetect. Word gaps only show where
 * the transcript has no words; this also catches breaths and room tone that Whisper skips.
 */

export type SilenceRange = { startMs: number; endMs: number };

export type SilenceOptions = {
  /** Anything quieter than this (dB) counts as silence. */
  noiseDb?: number;
  /** Silences shorter than this (seconds) are ignored. */
  minDurationSec?: number;
};

/** Reads silencedetect's log lines. Pure, so the parsing is testable without ffmpeg. */
export function parseSilencedetect(stderr: string): SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let open: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    const end = /silence_end:\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (start) {
      open = Number(start[1]) * 1000;
    } else if (end && open !== null) {
      const endMs = Number(end[1]) * 1000;
      if (endMs > open) ranges.push({ startMs: open, endMs });
      open = null;
    }
  }
  return ranges;
}

/**
 * Silences to cuts, with the same breathing room and minimum length as word pauses, so the two
 * sources agree on what a pause is. Pure.
 */
export function silenceToCuts(
  ranges: SilenceRange[],
  options: { pausePaddingMs: number; minPauseMs: number },
): CutRange[] {
  const cuts: CutRange[] = [];
  for (const range of ranges) {
    if (range.endMs - range.startMs < options.minPauseMs) continue;
    const startMs = range.startMs + options.pausePaddingMs;
    const endMs = range.endMs - options.pausePaddingMs;
    if (endMs > startMs) cuts.push({ startMs, endMs, reasons: ["silence"] });
  }
  return cuts;
}

export function detectSilences(wavPath: string, options: SilenceOptions = {}): SilenceRange[] {
  if (!existsSync(wavPath)) {
    throw new Error(`Audio file not found for silence detection: ${wavPath}`);
  }
  const noise = options.noiseDb ?? -35;
  const minDuration = options.minDurationSec ?? 0.4;

  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-nostats", "-i", wavPath, "-af", `silencedetect=noise=${noise}dB:d=${minDuration}`, "-f", "null", "-"],
    { encoding: "utf-8", timeout: 10 * 60_000 },
  );
  if (result.error) {
    throw new Error(`ffmpeg could not start for silence detection: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg silencedetect failed: ${(result.stderr || "no output").trim().slice(0, 400)}`);
  }
  return parseSilencedetect(result.stderr);
}
