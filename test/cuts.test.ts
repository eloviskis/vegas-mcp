import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectCuts, validateWords, type Word } from "../src/cuts/detect.js";

const w = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs });

describe("detectCuts: pauses", () => {
  it("cuts a long silence and keeps padding on each side", () => {
    // Gap 500→1500 is 1000 ms; 250 ms of padding is kept at each edge.
    const cuts = detectCuts([w("Oi", 0, 500), w("tudo", 1500, 2000)]);
    assert.deepEqual(cuts, [{ startMs: 750, endMs: 1250, reasons: ["pause"] }]);
  });

  it("leaves short gaps alone", () => {
    assert.deepEqual(detectCuts([w("a", 0, 500), w("b", 800, 1200)]), []);
  });

  it("honours custom padding and threshold", () => {
    const cuts = detectCuts([w("a", 0, 500), w("b", 1100, 1500)], {
      minPauseMs: 500,
      pausePaddingMs: 0,
    });
    assert.deepEqual(cuts, [{ startMs: 500, endMs: 1100, reasons: ["pause"] }]);
  });
});

describe("detectCuts: repeats", () => {
  it("cuts the failed first take of a repeated word and keeps the retake", () => {
    const cuts = detectCuts([w("eu", 0, 300), w("eu", 400, 700), w("quero", 800, 1200)]);
    assert.deepEqual(cuts, [{ startMs: 0, endMs: 400, reasons: ["repeat"] }]);
  });

  it("treats a repeated phrase as one retake, not two", () => {
    const cuts = detectCuts([
      w("vamos", 0, 300),
      w("lá", 350, 600),
      w("vamos", 700, 1000),
      w("lá", 1050, 1300),
      w("bora", 1350, 1700),
    ]);
    assert.deepEqual(cuts, [{ startMs: 0, endMs: 700, reasons: ["repeat"] }]);
  });

  it("ignores case and punctuation when comparing", () => {
    const cuts = detectCuts([w("Oi,", 0, 300), w("oi", 400, 600), w("tudo", 700, 1000)]);
    assert.deepEqual(cuts, [{ startMs: 0, endMs: 400, reasons: ["repeat"] }]);
  });

  it("does not call two copies a restart when they are far apart", () => {
    // Only the silence between them is cut, as a pause; no repeat cut is made.
    const cuts = detectCuts([w("eu", 0, 300), w("eu", 6000, 6300)]);
    assert.deepEqual(cuts, [{ startMs: 550, endMs: 5750, reasons: ["pause"] }]);
  });

  it("does not flag ordinary speech", () => {
    const cuts = detectCuts([
      w("o", 0, 200),
      w("carro", 250, 600),
      w("é", 650, 800),
      w("azul", 850, 1200),
    ]);
    assert.deepEqual(cuts, []);
  });
});

describe("detectCuts: merging", () => {
  it("merges a pause that sits inside a retake into one cut with both reasons", () => {
    // The pause (550→1250 after padding) lies inside the repeat span (0→1500).
    const cuts = detectCuts([w("eu", 0, 300), w("eu", 1500, 1800)]);
    assert.deepEqual(cuts, [{ startMs: 0, endMs: 1500, reasons: ["repeat", "pause"] }]);
  });

  it("returns nothing for empty input", () => {
    assert.deepEqual(detectCuts([]), []);
  });
});

describe("validateWords", () => {
  it("rejects a word that ends before it starts", () => {
    assert.throws(() => validateWords([w("a", 500, 500)]), /Word 1 \("a"\) ends at or before it starts/);
  });

  it("rejects overlapping words", () => {
    assert.throws(
      () => validateWords([w("a", 0, 500), w("b", 400, 900)]),
      /Word 2 \("b"\) starts before the previous word ends/,
    );
  });

  it("rejects negative or non-finite timing", () => {
    assert.throws(() => validateWords([w("a", -10, 500)]), /Word 1 \("a"\) has invalid timing/);
    assert.throws(() => validateWords([w("a", 0, Number.NaN)]), /has invalid timing/);
  });
});
