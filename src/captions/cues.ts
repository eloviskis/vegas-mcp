import type { Word } from "../cuts/detect.js";

/**
 * Caption cues from timed words. A cue is a short line on screen. Words are grouped until the
 * line gets too long, or until the speaker pauses, which is where a viewer naturally breaks.
 */

export type CaptionWord = { text: string; startMs: number; endMs: number };

export type CaptionCue = {
  startMs: number;
  endMs: number;
  text: string;
  /** The cue's words with their own times, for styles that light words up as they are spoken. */
  words?: CaptionWord[];
};

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
      words: current.map((w) => ({ text: w.text, startMs: w.startMs, endMs: w.endMs })),
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

/** Where a clip sits in its media. `playbackRate` is 1 unless the clip has been sped up. */
export type ClipTiming = { takeOffsetMs: number; lengthMs: number; playbackRate?: number };

/**
 * Moves cues from media time into one clip's own time. The clip plays its media from takeOffsetMs,
 * and at playbackRate each media millisecond takes 1 / rate timeline milliseconds, so a cue at
 * media 2–4 s in a clip at 2x lands at 1–2 s of the clip. Anything outside the media the clip plays
 * is dropped, and the rest is clipped to it. Used to turn transcript times into overlay times.
 */
export function cuesForClip(cues: CaptionCue[], clip: ClipTiming): CaptionCue[] {
  const rate = clip.playbackRate ?? 1;
  const mediaStart = clip.takeOffsetMs;
  const mediaEnd = clip.takeOffsetMs + clip.lengthMs * rate;
  const toClip = (mediaMs: number) => (mediaMs - mediaStart) / rate;

  const out: CaptionCue[] = [];
  for (const cue of cues) {
    const startMs = toClip(Math.max(cue.startMs, mediaStart));
    const endMs = Math.min(clip.lengthMs, toClip(Math.min(cue.endMs, mediaEnd)));
    if (endMs <= startMs) continue;

    const moved: CaptionCue = { startMs, endMs, text: cue.text };
    if (cue.words) {
      moved.words = cue.words.flatMap((word) => {
        const wordStart = toClip(Math.max(word.startMs, mediaStart));
        const wordEnd = Math.min(clip.lengthMs, toClip(Math.min(word.endMs, mediaEnd)));
        return wordEnd > wordStart ? [{ text: word.text, startMs: wordStart, endMs: wordEnd }] : [];
      });
    }
    out.push(moved);
  }
  return out;
}
