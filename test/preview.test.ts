import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSheet, defaultSheetPath, sheetArgs, sheetTimes, SheetError } from "../src/vegas/preview.js";

describe("sheetTimes", () => {
  it("spreads the frames evenly from the start of the file", () => {
    assert.deepEqual(sheetTimes(60000, 4), [0, 15000, 30000, 45000]);
  });
});

describe("sheetArgs", () => {
  it("takes one frame per slice and tiles them into rows of the given width", () => {
    const args = sheetArgs("in.mp4", "out.png", 60000, { frames: 12, columns: 4, width: 320 });
    const vf = args[args.indexOf("-vf") + 1];
    assert.equal(vf, "fps=1/5.0000,scale=320:-2,tile=4x3");
    assert.equal(args.at(-1), "out.png");
  });

  it("rounds the rows up when the frames do not fill the last row", () => {
    const args = sheetArgs("in.mp4", "out.png", 60000, { frames: 10, columns: 4 });
    assert.ok(args[args.indexOf("-vf") + 1]!.endsWith("tile=4x3"));
  });
});

describe("buildSheet", () => {
  it("refuses a file with no length to sample", () => {
    assert.throws(() => buildSheet("in.mp4", "out.png", 0), SheetError);
  });
});

describe("defaultSheetPath", () => {
  it("names the sheet after the file, under out/sheets, with a timestamp", () => {
    const path = defaultSheetPath("C:/renders/speed-2x.mp4", new Date("2026-10-05T18:30:00Z"));
    assert.match(path.replace(/\\/g, "/"), /\/out\/sheets\/speed-2x-sheet-2026-10-05T18-30-00-000Z\.png$/);
  });
});
