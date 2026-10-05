import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { detectCuts, mergeRanges, type CutRange, type DetectOptions, type Word } from "../cuts/detect.js";
import { detectSilences, silenceToCuts } from "../cuts/silence.js";
import { extractAudio, transcribeWords } from "../transcribe/transcribe.js";

export { listAudioTracks, type AudioTrack } from "../transcribe/transcribe.js";

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
  /** Audio track to transcribe, 0-based among audio tracks. Defaults to 0. See listAudioTracks. */
  audioTrack?: number;
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

  extractAudio(request.path, audioPath, request.audioTrack ?? 0);
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

/** The words in a .words.json, validated. Captions and cut detection both start here. */
export function readWords(wordsPath: string): Word[] {
  if (!existsSync(wordsPath)) {
    throw new Error(`Words file not found: ${wordsPath}`);
  }
  const parsed = wordsFileSchema.safeParse(JSON.parse(readFileSync(wordsPath, "utf-8")));
  if (!parsed.success) {
    throw new Error(`Words file has an unexpected shape: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data.words;
}

/** The media file a .words.json was made from, so a plan can check it matches the clip. */
export function readWordsSource(wordsPath: string): string | undefined {
  if (!existsSync(wordsPath)) {
    throw new Error(`Words file not found: ${wordsPath}`);
  }
  const parsed = wordsFileSchema.safeParse(JSON.parse(readFileSync(wordsPath, "utf-8")));
  return parsed.success ? parsed.data.source : undefined;
}

export type FindSpeechCutsRequest = DetectOptions & {
  wordsPath: string;
  /** The WAV transcribe_speech extracted. When given, silences measured in the audio are cut too. */
  audioPath?: string;
};

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

  const { wordsPath: _ignored, audioPath, ...options } = request;
  const words = parsed.data.words;
  const wordCuts = detectCuts(words, options);

  // Silences from the audio catch breaths and room tone that the transcript skips over.
  const silenceCuts = audioPath
    ? silenceToCuts(detectSilences(audioPath), {
        pausePaddingMs: options.pausePaddingMs ?? 250,
        minPauseMs: options.minPauseMs ?? 700,
      })
    : [];
  const ranges = mergeRanges([...wordCuts, ...silenceCuts]);

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
