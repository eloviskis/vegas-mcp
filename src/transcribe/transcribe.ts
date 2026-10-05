import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Word } from "../cuts/detect.js";

/**
 * Local transcription with word timestamps. Nothing leaves the machine and no paid API is
 * involved: ffmpeg pulls the audio out and faster-whisper, in its own virtualenv, reads it.
 *
 * The Python side lives in `~/.vegas-mcp/whisper-venv` rather than in the repo, so the
 * package does not carry hundreds of megabytes of ML dependencies.
 */

export type TranscribeRequest = {
  /** Audio file to transcribe. Video works too, but extract first to keep calls cheap. */
  audioPath: string;
  /** Whisper model size. Defaults to "small": a fair balance of speed and accuracy on CPU. */
  model?: string;
  /** ISO language code, e.g. "pt". Omit to let Whisper detect it. */
  language?: string;
  /**
   * Asks Whisper for a verbatim transcript. Without it Whisper quietly drops stutters
   * ("eu eu quero" becomes "eu quero"), and the repeat detector never sees them.
   * On by default; turn off only when you want clean subtitles rather than cut evidence.
   */
  verbatim?: boolean;
};

/** Portuguese example text nudges Whisper to keep fillers and repeats. */
const VERBATIM_PROMPT = "Transcrição literal, com hesitações e repetições: eu, eu, hum, a gente, a gente vai, hoje, hoje.";

export type TranscribeResult = {
  language: string;
  durationMs: number;
  words: Word[];
};

export class TranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscribeError";
  }
}

/** Overrides the default venv, for machines where it lives somewhere else. */
const pythonPath = (): string => {
  if (process.env.VEGAS_MCP_PYTHON) return process.env.VEGAS_MCP_PYTHON;
  const venv = join(homedir(), ".vegas-mcp", "whisper-venv");
  return process.platform === "win32"
    ? join(venv, "Scripts", "python.exe")
    : join(venv, "bin", "python");
};

/**
 * Passed with `-c`, so there is no script file to ship. Writes one JSON line on stdout and
 * nothing else there; diagnostics go to stderr.
 */
const WHISPER_SCRIPT = `
import json, sys
from faster_whisper import WhisperModel

audio, model_name, language, prompt = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
model = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = model.transcribe(
    audio,
    language=language or None,
    word_timestamps=True,
    vad_filter=False,
    initial_prompt=prompt or None,
)
words = []
for segment in segments:
    for w in segment.words or []:
        words.append({"text": w.word.strip(), "startMs": round(w.start * 1000), "endMs": round(w.end * 1000)})
json.dump(
    {"language": info.language, "durationMs": round(info.duration * 1000), "words": words},
    sys.stdout,
    ensure_ascii=False,
)
`;

/**
 * Whisper can emit overlapping or zero-length word timings. The cut detector refuses both,
 * so they are repaired here, once, rather than at every call site.
 */
export function normaliseWords(raw: Array<{ text: string; startMs: number; endMs: number }>): Word[] {
  const words: Word[] = [];
  for (const item of raw) {
    const text = item.text.trim();
    if (text === "") continue;

    const previousEnd = words.at(-1)?.endMs ?? 0;
    const startMs = Math.max(item.startMs, previousEnd);
    const endMs = Math.max(item.endMs, startMs + 1);
    words.push({ text, startMs, endMs });
  }
  return words;
}

export function extractAudio(inputPath: string, wavPath: string): void {
  if (!existsSync(inputPath)) {
    throw new TranscribeError(`Media file not found: ${inputPath}`);
  }
  mkdirSync(dirname(wavPath), { recursive: true });

  // 16 kHz mono PCM is what Whisper resamples to anyway; giving it that directly skips work.
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-v", "error", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavPath],
    { encoding: "utf-8", timeout: 10 * 60_000 },
  );
  if (result.error) {
    throw new TranscribeError(`ffmpeg could not start: ${result.error.message}. Is it on PATH?`);
  }
  if (result.status !== 0) {
    throw new TranscribeError(`ffmpeg failed: ${(result.stderr || "no output").trim().slice(0, 600)}`);
  }
}

export function transcribeWords(request: TranscribeRequest): TranscribeResult {
  if (!existsSync(request.audioPath)) {
    throw new TranscribeError(`Audio file not found: ${request.audioPath}`);
  }

  const python = pythonPath();
  if (!existsSync(python)) {
    throw new TranscribeError(
      `Whisper environment missing at ${python}. Create it with: python -m venv ~/.vegas-mcp/whisper-venv && <venv>/pip install faster-whisper`,
    );
  }

  const result = spawnSync(
    python,
    [
      "-c",
      WHISPER_SCRIPT,
      request.audioPath,
      request.model ?? "small",
      request.language ?? "",
      request.verbatim === false ? "" : VERBATIM_PROMPT,
    ],
    { encoding: "utf-8", timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) {
    throw new TranscribeError(`Whisper could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new TranscribeError(`Whisper failed: ${(result.stderr || "no output").trim().slice(-800)}`);
  }

  const parsed = JSON.parse(result.stdout) as {
    language: string;
    durationMs: number;
    words: Array<{ text: string; startMs: number; endMs: number }>;
  };
  return {
    language: parsed.language,
    durationMs: parsed.durationMs,
    words: normaliseWords(parsed.words),
  };
}
