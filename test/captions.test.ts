import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cuesForClip, wordsToCues } from "../src/captions/cues.js";
import type { Word } from "../src/cuts/detect.js";

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs });

describe("wordsToCues", () => {
  it("breaks a line at a pause, so a speaker's pause becomes a new caption", () => {
    const cues = wordsToCues([w("Oi", 0, 300), w("tudo", 350, 700), w("bem", 2000, 2300)]);
    assert.deepEqual(cues, [
      { startMs: 0, endMs: 700, text: "Oi tudo" },
      { startMs: 2000, endMs: 2300, text: "bem" },
    ]);
  });

  it("breaks a line after maxWords even without a pause", () => {
    const words = ["um", "dois", "tres", "quatro"].map((t, i) => w(t, i * 300, i * 300 + 250));
    const cues = wordsToCues(words, { maxWords: 3 });
    assert.deepEqual(cues.map((c) => c.text), ["um dois tres", "quatro"]);
  });

  it("breaks a line before it exceeds maxChars", () => {
    const cues = wordsToCues(
      [w("aaaaaaaaaa", 0, 200), w("bbbbbbbbbb", 250, 450)],
      { maxChars: 15 },
    );
    assert.deepEqual(cues.map((c) => c.text), ["aaaaaaaaaa", "bbbbbbbbbb"]);
  });

  it("returns nothing for no words", () => {
    assert.deepEqual(wordsToCues([]), []);
  });
});

describe("cuesForClip", () => {
  it("moves cues into the clip's own time and clips them at its edges", () => {
    // Clip plays media from 4 s for 10 s. A cue at 3–5 s keeps only its 4–5 s part, which is 0–1 s in the clip.
    const out = cuesForClip(
      [
        { startMs: 3000, endMs: 5000, text: "a" },
        { startMs: 20000, endMs: 21000, text: "fora" },
      ],
      { takeOffsetMs: 4000, lengthMs: 10000 },
    );
    assert.deepEqual(out, [{ startMs: 0, endMs: 1000, text: "a" }]);
  });
});
