import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSrt, parseSrt, shiftCues } from "../src/workflows/srt.js";

const SAMPLE = [
  "1",
  "00:00:01,000 --> 00:00:02,500",
  "Olá, mundo",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,000",
  "Привет",
  "линия два",
].join("\r\n");

describe("parseSrt", () => {
  it("reads cues with millisecond timing, CRLF and multi-line text", () => {
    const cues = parseSrt(SAMPLE);
    assert.equal(cues.length, 2);
    assert.equal(cues[0]!.startMs, 1000);
    assert.equal(cues[0]!.endMs, 2500);
    assert.equal(cues[1]!.text, "Привет\nлиния два");
  });

  it("strips a UTF-8 BOM", () => {
    assert.equal(parseSrt("﻿" + SAMPLE).length, 2);
  });

  it("rejects an empty file", () => {
    assert.throws(() => parseSrt("   \n"), /empty/);
  });

  it("names the cue whose timing is malformed", () => {
    assert.throws(() => parseSrt("1\n00:00:01 --> 00:00:02\nx"), /Cue 1 has an invalid timing line/);
  });

  it("rejects a cue that ends before it starts", () => {
    assert.throws(
      () => parseSrt("1\n00:00:05,000 --> 00:00:04,000\nx"),
      /Cue 1 ends at or before it starts/,
    );
  });
});

describe("formatSrt", () => {
  it("round-trips through parse with renumbered indices and dot-free timestamps", () => {
    const out = formatSrt(parseSrt(SAMPLE));
    assert.equal(out, "1\n00:00:01,000 --> 00:00:02,500\nOlá, mundo\n\n2\n00:00:03,000 --> 00:00:04,000\nПривет\nлиния два\n");
    assert.deepEqual(parseSrt(out), parseSrt(SAMPLE).map((c, i) => ({ ...c, index: i + 1 })));
  });
});

describe("shiftCues", () => {
  it("moves every cue by the offset", () => {
    const shifted = shiftCues(parseSrt(SAMPLE), 500);
    assert.equal(shifted[0]!.startMs, 1500);
    assert.equal(shifted[1]!.endMs, 4500);
  });

  it("refuses a negative offset that pushes a cue before zero", () => {
    assert.throws(() => shiftCues(parseSrt(SAMPLE), -1500), /Cue 1 would start before 0:00/);
  });

  it("returns the input unchanged for a zero offset", () => {
    const cues = parseSrt(SAMPLE);
    assert.equal(shiftCues(cues, 0), cues);
  });
});
