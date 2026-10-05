import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fadeNormalizeConflict, stateAfter } from "../src/vegas/audio.js";

const plain = { fadeInMs: 0, fadeOutMs: 0, normalize: false };

describe("fadeNormalizeConflict", () => {
  it("allows normalisation on an event with no fades", () => {
    assert.equal(fadeNormalizeConflict(plain, { normalize: true }), null);
  });

  it("allows fades on an event that is not normalised", () => {
    assert.equal(fadeNormalizeConflict(plain, { fadeInMs: 1000, fadeOutMs: 1000 }), null);
  });

  it("refuses to normalise an event that already has fades", () => {
    const faded = { fadeInMs: 10, fadeOutMs: 0, normalize: false };
    assert.match(fadeNormalizeConflict(faded, { normalize: true }) ?? "", /silence/);
  });

  it("refuses to add fades to an event that is already normalised", () => {
    const normalised = { fadeInMs: 0, fadeOutMs: 0, normalize: true };
    assert.match(fadeNormalizeConflict(normalised, { fadeInMs: 500 }) ?? "", /silence/);
  });

  it("allows removing the fades of a normalised event, which clears the conflict", () => {
    const normalised = { fadeInMs: 1000, fadeOutMs: 1000, normalize: true };
    assert.equal(fadeNormalizeConflict(normalised, { fadeInMs: 0, fadeOutMs: 0 }), null);
  });
});

describe("stateAfter", () => {
  it("keeps what the change does not mention", () => {
    assert.deepEqual(stateAfter({ fadeInMs: 5, fadeOutMs: 6, normalize: true }, { fadeOutMs: 0 }), {
      fadeInMs: 5,
      fadeOutMs: 0,
      normalize: true,
    });
  });
});
