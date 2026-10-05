/**
 * Finds the parts of a recording worth cutting: long silences and failed takes, where the
 * speaker stumbles and says the same phrase again. The last take is kept.
 *
 * Pure on purpose. The words come from a transcript, so the decisions can be tested
 * without audio, Whisper or VEGAS.
 */

export type Word = { text: string; startMs: number; endMs: number };

export type CutReason = "pause" | "repeat" | "restart";

export type CutRange = { startMs: number; endMs: number; reasons: CutReason[] };

export type DetectOptions = {
  /** Silences at least this long are candidates for cutting. */
  minPauseMs?: number;
  /** Breathing room kept at each edge of a cut pause, so speech does not sound clipped. */
  pausePaddingMs?: number;
  /** Longest repeated phrase, in words, to look for. */
  maxRepeatWords?: number;
  /** Copies of a phrase further apart than this are not a restart. */
  maxRepeatGapMs?: number;
  /**
   * A run of this many words said again later is a restart: the speaker stumbled and began
   * the sentence over. Short repeats ("a única coisa que") are idioms, not restarts. 0 turns
   * restart detection off.
   */
  restartSpanWords?: number;
  /** How many words after the first take the second copy must start. */
  restartWindowWords?: number;
};

const DEFAULTS: Required<DetectOptions> = {
  minPauseMs: 700,
  pausePaddingMs: 250,
  maxRepeatWords: 6,
  maxRepeatGapMs: 4000,
  restartSpanWords: 6,
  restartWindowWords: 30,
};

const normalize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Words must be ordered, non-overlapping, and last for a positive time. */
export function validateWords(words: Word[]): void {
  words.forEach((word, i) => {
    if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) || word.startMs < 0) {
      throw new Error(`Word ${i + 1} ("${word.text}") has invalid timing.`);
    }
    if (word.endMs <= word.startMs) {
      throw new Error(`Word ${i + 1} ("${word.text}") ends at or before it starts.`);
    }
    if (i > 0 && word.startMs < words[i - 1]!.endMs) {
      throw new Error(`Word ${i + 1} ("${word.text}") starts before the previous word ends.`);
    }
  });
}

export function detectPauses(words: Word[], options: Required<DetectOptions>): CutRange[] {
  const cuts: CutRange[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gapStart = words[i]!.endMs;
    const gapEnd = words[i + 1]!.startMs;
    if (gapEnd - gapStart < options.minPauseMs) continue;

    const startMs = gapStart + options.pausePaddingMs;
    const endMs = gapEnd - options.pausePaddingMs;
    if (endMs > startMs) cuts.push({ startMs, endMs, reasons: ["pause"] });
  }
  return cuts;
}

/** True when the `n` words at `a` and the `n` words at `b` read the same. */
const sameRun = (tokens: string[], a: number, b: number, n: number): boolean => {
  for (let k = 0; k < n; k++) {
    if (tokens[a + k] !== tokens[b + k]) return false;
  }
  return true;
};

/**
 * Looks for a phrase said twice in a row. The span from the first copy up to the second
 * is cut, so the retake that follows survives. Longer phrases win over shorter ones, so
 * "vamos lá vamos lá" is one retake rather than two.
 */
export function detectRepeats(words: Word[], options: Required<DetectOptions>): CutRange[] {
  const tokens = words.map((word) => normalize(word.text));
  const cuts: CutRange[] = [];

  let i = 0;
  while (i < words.length) {
    let matched = 0;
    const longest = Math.min(options.maxRepeatWords, Math.floor((words.length - i) / 2));

    for (let n = longest; n >= 1; n--) {
      // Empty tokens (stray punctuation) cannot be a phrase on their own.
      if (tokens.slice(i, i + n).some((t) => t === "")) continue;
      if (!sameRun(tokens, i, i + n, n)) continue;

      const gap = words[i + n]!.startMs - words[i + n - 1]!.endMs;
      if (gap > options.maxRepeatGapMs) continue;

      matched = n;
      break;
    }

    if (matched === 0) {
      i++;
      continue;
    }

    cuts.push({
      startMs: words[i]!.startMs,
      endMs: words[i + matched]!.startMs,
      reasons: ["repeat"],
    });
    i += matched;
  }
  return cuts;
}

/**
 * Finds a sentence started again. The first take runs from the first word up to the point
 * where a run of at least `restartSpanWords` words comes back. That whole first take is cut.
 * Adjacent single-word stutters are handled by detectRepeats; this catches longer restarts
 * with other words between the two takes.
 */
export function detectRestarts(words: Word[], options: Required<DetectOptions>): CutRange[] {
  if (options.restartSpanWords <= 0) return [];

  const tokens = words.map((word) => normalize(word.text));
  const cuts: CutRange[] = [];

  let i = 0;
  while (i < words.length) {
    let restartAt = -1;

    for (let j = i + 1; j < words.length && j - i <= options.restartWindowWords; j++) {
      // Length of the run where word i+k matches word j+k, never crossing into the second take.
      let k = 0;
      while (i + k < j && j + k < words.length && tokens[i + k] !== "" && tokens[i + k] === tokens[j + k]) {
        k++;
      }
      if (k >= options.restartSpanWords) {
        restartAt = j;
        break;
      }
    }

    if (restartAt === -1) {
      i++;
      continue;
    }

    cuts.push({ startMs: words[i]!.startMs, endMs: words[restartAt]!.startMs, reasons: ["restart"] });
    i = restartAt;
  }
  return cuts;
}

/** Joins ranges that touch or overlap, so the editor gets one cut rather than a stack. */
export function mergeRanges(ranges: CutRange[]): CutRange[] {
  const sorted = [...ranges].sort((a, b) => a.startMs - b.startMs);
  const merged: CutRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, range.endMs);
      for (const reason of range.reasons) {
        if (!last.reasons.includes(reason)) last.reasons.push(reason);
      }
    } else {
      merged.push({ ...range, reasons: [...range.reasons] });
    }
  }
  return merged;
}

export function detectCuts(words: Word[], options: DetectOptions = {}): CutRange[] {
  validateWords(words);
  const resolved = { ...DEFAULTS, ...options };

  return mergeRanges([
    ...detectRestarts(words, resolved),
    ...detectRepeats(words, resolved),
    ...detectPauses(words, resolved),
  ]);
}
