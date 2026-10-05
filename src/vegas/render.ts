import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks a rendered file the way the user cares about it: are the video and audio the same
 * length? A cut that removed video but not audio would show up here as a gap.
 */

export type StreamDurations = {
  videoMs?: number;
  audioMs?: number;
  containerMs?: number;
};

/** Reads durations from ffprobe's JSON. Pure, so the parsing is testable without a file. */
export function parseStreamDurations(json: unknown): StreamDurations {
  const data = json as {
    streams?: Array<{ codec_type?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const out: StreamDurations = {};
  for (const stream of data.streams ?? []) {
    const ms = Number(stream.duration) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (stream.codec_type === "video" && out.videoMs === undefined) out.videoMs = ms;
    if (stream.codec_type === "audio" && out.audioMs === undefined) out.audioMs = ms;
  }
  const container = Number(data.format?.duration) * 1000;
  if (Number.isFinite(container) && container > 0) out.containerMs = container;
  return out;
}

/** Video minus audio, in ms. Null when either stream is missing. */
export function avDifferenceMs(d: StreamDurations): number | null {
  if (d.videoMs === undefined || d.audioMs === undefined) return null;
  return Math.round((d.videoMs - d.audioMs) * 10) / 10;
}

export function probeDurations(path: string): StreamDurations {
  if (!existsSync(path)) {
    throw new Error(`Rendered file not found: ${path}`);
  }
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", path],
    { encoding: "utf-8", timeout: 120_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`ffprobe could not read ${path}: ${(result.stderr || result.error?.message || "no output").trim().slice(0, 400)}`);
  }
  return parseStreamDurations(JSON.parse(result.stdout));
}

/** Width and height of the first video stream, from ffprobe's JSON. Null when there is none. */
export function parseVideoSize(json: unknown): { width: number; height: number } | null {
  const stream = (json as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
  if (!stream || !stream.width || !stream.height) return null;
  return { width: stream.width, height: stream.height };
}

export function probeVideoSize(path: string): { width: number; height: number } | null {
  if (!existsSync(path)) {
    throw new Error(`Media file not found: ${path}`);
  }
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path],
    { encoding: "utf-8", timeout: 60_000 },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`ffprobe could not read ${path}: ${(result.stderr || result.error?.message || "no output").trim().slice(0, 300)}`);
  }
  return parseVideoSize(JSON.parse(result.stdout));
}

/**
 * Below this mean brightness (0 to 255) a frame counts as black. Measured: black renders read 0,
 * real footage reads 28 and up.
 */
export const BLANK_LUMA = 4;
/**
 * Below this loudest level, in dB, the audio counts as silent. Measured: silent renders read
 * -91 dB, real audio reads -1.6 dB and up.
 */
export const SILENT_DB = -80;

export type ContentCheck = {
  /** Mean brightness, 0 to 255, of frames spread through the file. */
  lumaMeans: number[];
  /** Loudest sample, in dB. Null when the file has no audio to measure. */
  maxVolumeDb: number | null;
  looksBlank: boolean;
  looksSilent: boolean;
};

/** Decides from the measured values. Pure, so the thresholds are testable without a file. */
export function classifyContent(lumaMeans: number[], maxVolumeDb: number | null): Pick<ContentCheck, "looksBlank" | "looksSilent"> {
  return {
    looksBlank: lumaMeans.length > 0 && Math.max(...lumaMeans) < BLANK_LUMA,
    looksSilent: maxVolumeDb !== null && maxVolumeDb < SILENT_DB,
  };
}

/** Reads the peak level from ffmpeg's volumedetect report. Pure. Null when there is no such line. */
export function parseMaxVolume(report: string): number | null {
  const match = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(report);
  return match ? Number(match[1]) : null;
}

/** Mean brightness of the frame at `atSeconds`, or null when ffmpeg cannot read it. */
function frameLuma(path: string, atSeconds: number): number | null {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-ss", String(atSeconds), "-i", path, "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"],
    { maxBuffer: 1 << 24, timeout: 120_000 },
  );
  if (result.error || result.status !== 0 || !result.stdout || result.stdout.length === 0) return null;
  let sum = 0;
  for (const value of result.stdout) sum += value;
  return sum / result.stdout.length;
}

/**
 * Looks at what the file contains, not only how long it is. A render can have the right length and
 * still be black and silent, which the length check cannot see. Samples five frames across the file
 * and the loudest sample. Uses ffmpeg.
 */
export function inspectContent(path: string, durationMs: number): ContentCheck {
  const lumaMeans = [0.1, 0.3, 0.5, 0.7, 0.9]
    .map((fraction) => frameLuma(path, (durationMs * fraction) / 1000))
    .filter((value): value is number => value !== null);
  const volume = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-i", path, "-vn", "-af", "volumedetect", "-f", "null", "-"],
    { encoding: "utf-8", timeout: 300_000 },
  );
  const maxVolumeDb = parseMaxVolume(volume.stderr ?? "");
  return {
    lumaMeans: lumaMeans.map((value) => Math.round(value * 10) / 10),
    maxVolumeDb,
    ...classifyContent(lumaMeans, maxVolumeDb),
  };
}

/** `<package>/out/renders/render-<timestamp>.mp4`, same folder convention as the other tools. */
export function defaultRenderPath(now: Date = new Date()): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(resolve(here, "..", "..", "out", "renders"), `render-${stamp}.mp4`);
}
