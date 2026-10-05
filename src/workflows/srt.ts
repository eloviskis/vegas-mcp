import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Cue = { index: number; startMs: number; endMs: number; text: string };

export type PrepareSubtitlesRequest = {
  /** Path to an .srt file. Mutually exclusive with `content`. */
  path?: string;
  /** Raw SRT text. Mutually exclusive with `path`. */
  content?: string;
  /** Shifts every cue. Negative values move cues earlier. */
  timeOffsetSeconds?: number;
  /** Absolute path for the normalised .srt. */
  outputPath: string;
};

export type PrepareSubtitlesResult = {
  path: string;
  cues: number;
  firstStartSeconds: number;
  lastEndSeconds: number;
};

const TIME = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;
const ARROW = /^\s*(\S+)\s*-->\s*(\S+)\s*$/;

const toMs = (stamp: string): number | undefined => {
  const m = TIME.exec(stamp);
  if (!m) return undefined;
  const [, h, min, s, ms] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + Number(ms);
};

const fromMs = (total: number): string => {
  const ms = total % 1000;
  const seconds = Math.floor(total / 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)},${pad(ms, 3)}`;
};

export function parseSrt(source: string): Cue[] {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim();
  if (text === "") throw new Error("The SRT is empty.");

  const blocks = text.split(/\n{2,}/);
  return blocks.map((block, i) => {
    const lines = block.split("\n");
    const arrowAt = lines.findIndex((line) => line.includes("-->"));
    if (arrowAt === -1) throw new Error(`Cue ${i + 1} has no timing line.`);

    const arrow = ARROW.exec(lines[arrowAt]!);
    const startMs = arrow ? toMs(arrow[1]!) : undefined;
    const endMs = arrow ? toMs(arrow[2]!) : undefined;
    if (startMs === undefined || endMs === undefined) {
      throw new Error(`Cue ${i + 1} has an invalid timing line: "${lines[arrowAt]}".`);
    }
    if (endMs <= startMs) {
      throw new Error(`Cue ${i + 1} ends at or before it starts.`);
    }

    const body = lines.slice(arrowAt + 1).join("\n").trim();
    return { index: i + 1, startMs, endMs, text: body };
  });
}

export function formatSrt(cues: Cue[]): string {
  return (
    cues
      .map((cue, i) => `${i + 1}\n${fromMs(cue.startMs)} --> ${fromMs(cue.endMs)}\n${cue.text}`)
      .join("\n\n") + "\n"
  );
}

export function shiftCues(cues: Cue[], offsetMs: number): Cue[] {
  if (offsetMs === 0) return cues;
  return cues.map((cue) => {
    const startMs = cue.startMs + offsetMs;
    const endMs = cue.endMs + offsetMs;
    if (startMs < 0) {
      throw new Error(
        `Cue ${cue.index} would start before 0:00 after the offset. Use a smaller negative offset.`,
      );
    }
    return { ...cue, startMs, endMs };
  });
}

export function prepareSubtitles(request: PrepareSubtitlesRequest): PrepareSubtitlesResult {
  if (!request.path && !request.content) {
    throw new Error("Supply either `path` to an .srt file or `content` with raw SRT text.");
  }
  if (request.path && request.content) {
    throw new Error("Supply `path` or `content`, not both.");
  }
  if (request.path && !existsSync(request.path)) {
    throw new Error(`SRT file not found: ${request.path}`);
  }

  const source = request.path ? readFileSync(request.path, "utf-8") : request.content!;
  const offsetMs = Math.round((request.timeOffsetSeconds ?? 0) * 1000);
  const cues = shiftCues(parseSrt(source), offsetMs);

  mkdirSync(dirname(request.outputPath), { recursive: true });
  writeFileSync(request.outputPath, formatSrt(cues), "utf-8");

  return {
    path: request.outputPath,
    cues: cues.length,
    firstStartSeconds: cues[0]!.startMs / 1000,
    lastEndSeconds: cues[cues.length - 1]!.endMs / 1000,
  };
}
