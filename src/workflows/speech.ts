import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { detectCuts, type CutRange, type DetectOptions, type Word } from "../cuts/detect.js";
import { extractAudio, transcribeWords } from "../transcribe/transcribe.js";

/**
 * The two speech tools the MCP exposes before the VEGAS bridge exists. Neither one touches
 * a project: they read a media file, write new files to `out/`, and return what they found.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** `src/workflows/` → `<package root>/out`, and the same from `dist/workflows/`. */
const defaultOutputDir = resolve(here, "..", "..", "out");

export type TranscribeSpeechRequest = {
  /** Video or audio file. It is read, never changed. */
  path: string;
  /** Where the WAV and JSON go. Defaults to `<package>/out/`. */
  outputDir?: string;
  model?: string;
  language?: string;
  verbatim?: boolean;
};

export type TranscribeSpeechResult = {
  wordsPath: string;
  audioPath: string;
  language: string;
  durationMs: number;
  wordCount: number;
};

/** The file `transcribe_speech` writes and `find_speech_cuts` reads. */
export const wordsFileSchema = z.object({
  source: z.string().optional(),
  language: z.string().optional(),
  durationMs: z.number().optional(),
  words: z.array(z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })),
});

export function transcribeSpeech(request: TranscribeSpeechRequest): TranscribeSpeechResult {
  if (!existsSync(request.path)) {
    throw new Error(`Media file not found: ${request.path}`);
  }

  const outputDir = request.outputDir ?? defaultOutputDir;
  const stem = basename(request.path, extname(request.path));
  const audioPath = join(outputDir, `${stem}.speech.wav`);
  const wordsPath = join(outputDir, `${stem}.words.json`);

  extractAudio(request.path, audioPath);
  const result = transcribeWords({
    audioPath,
    model: request.model,
    language: request.language,
    verbatim: request.verbatim,
  });

  const file = {
    source: request.path,
    language: result.language,
    durationMs: result.durationMs,
    words: result.words,
  };
  writeFileSync(wordsPath, JSON.stringify(file, null, 2), "utf-8");

  return {
    wordsPath,
    audioPath,
    language: result.language,
    durationMs: result.durationMs,
    wordCount: result.words.length,
  };
}

export type FindSpeechCutsRequest = DetectOptions & { wordsPath: string };

export type SpeechCut = CutRange & {
  durationMs: number;
  /** The words inside the cut, so you can check what is being removed. */
  text: string;
};

export type FindSpeechCutsResult = {
  cuts: SpeechCut[];
  count: number;
  totalCutMs: number;
};

/** Words fully inside the cut. A pause has none, so it says so rather than printing nothing. */
const textWithin = (words: Word[], cut: CutRange): string => {
  const inside = words
    .filter((w) => w.startMs >= cut.startMs && w.endMs <= cut.endMs)
    .map((w) => w.text);
  return inside.length > 0 ? inside.join(" ") : "(silêncio)";
};

export function findSpeechCuts(request: FindSpeechCutsRequest): FindSpeechCutsResult {
  if (!existsSync(request.wordsPath)) {
    throw new Error(`Words file not found: ${request.wordsPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(request.wordsPath, "utf-8"));
  } catch {
    throw new Error(`Not valid JSON: ${request.wordsPath}. Run transcribe_speech first.`);
  }

  const parsed = wordsFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "root";
    throw new Error(`Words file has an unexpected shape at "${where}": ${issue?.message ?? "invalid"}`);
  }

  const { wordsPath: _ignored, ...options } = request;
  const words = parsed.data.words;
  const ranges = detectCuts(words, options);

  const cuts: SpeechCut[] = ranges.map((range) => ({
    ...range,
    durationMs: range.endMs - range.startMs,
    text: textWithin(words, range),
  }));

  return {
    cuts,
    count: cuts.length,
    totalCutMs: cuts.reduce((sum, cut) => sum + cut.durationMs, 0),
  };
}
