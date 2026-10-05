import type { Word } from "../cuts/detect.js";

/**
 * Caption cues from timed words. A cue is a short line on screen. Words are grouped until the
 * line gets too long, or until the speaker pauses, which is where a viewer naturally breaks.
 */

export type CaptionCue = { startMs: number; endMs: number; text: string };

export type CueOptions = {
  /** Most words on one line. */
  maxWords?: number;
  /** Most characters on one line, spaces included. */
  maxChars?: number;
  /** A silence this long between two words starts a new line. */
  breakGapMs?: number;
};

export function wordsToCues(words: Word[], options: CueOptions = {}): CaptionCue[] {
  const maxWords = options.maxWords ?? 7;
  const maxChars = options.maxChars ?? 42;
  const breakGapMs = options.breakGapMs ?? 600;

  const cues: CaptionCue[] = [];
  let current: Word[] = [];

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
  };

  for (const word of words) {
    const last = current[current.length - 1];
    if (last && word.startMs - last.endMs >= breakGapMs) flush();

    const candidate = [...current.map((w) => w.text), word.text].join(" ");
    if (current.length >= maxWords || (current.length > 0 && candidate.length > maxChars)) flush();

    current.push(word);
  }
  flush();
  return cues;
}

/**
 * Keeps only the part of each cue that falls inside a clip, and moves it to the clip's own time.
 * Used to turn transcript times (media time) into overlay times for one timeline clip.
 */
export function cuesForClip(
  cues: CaptionCue[],
  clip: { takeOffsetMs: number; lengthMs: number },
): CaptionCue[] {
  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const startMs = Math.max(0, cue.startMs - clip.takeOffsetMs);
    const endMs = Math.min(clip.lengthMs, cue.endMs - clip.takeOffsetMs);
    if (endMs > startMs) out.push({ startMs, endMs, text: cue.text });
  }
  return out;
}
