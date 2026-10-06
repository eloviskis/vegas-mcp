import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { sendBridgeCommand, BridgeError } from "../src/vegas/bridge.js";
import {
  PlanStore,
  expectedLengthAfter,
  removalOrder,
  sameMediaFile,
  snapCutsToFrames,
  timelineFingerprint,
  toTimelineCuts,
  type TimelineCut,
} from "../src/vegas/plan.js";

describe("timelineFingerprint", () => {
  it("is the same for the same timeline and different once a clip moves", () => {
    const before = { tracks: [{ index: 0, events: [{ index: 0, startMs: 0, lengthMs: 5000 }] }] };
    const same = { tracks: [{ index: 0, events: [{ index: 0, startMs: 0, lengthMs: 5000 }] }] };
    const moved = { tracks: [{ index: 0, events: [{ index: 0, startMs: 100, lengthMs: 5000 }] }] };
    assert.equal(timelineFingerprint(before), timelineFingerprint(same));
    assert.notEqual(timelineFingerprint(before), timelineFingerprint(moved));
  });
});

describe("sameMediaFile", () => {
  it("treats slash direction and letter case as the same Windows file", () => {
    assert.equal(sameMediaFile("C:\\Users\\example\\Videos\\IMG_6592.MOV", "c:/users/example/videos/img_6592.mov"), true);
  });

  it("refuses a different file, or a missing path", () => {
    assert.equal(sameMediaFile("C:/a/one.mov", "C:/a/two.mov"), false);
    assert.equal(sameMediaFile(undefined, "C:/a/one.mov"), false);
    assert.equal(sameMediaFile("C:/a/one.mov", ""), false);
  });
});

describe("toTimelineCuts", () => {
  const cut = (startMs: number, endMs: number) => ({ startMs, endMs, reasons: ["pause"], text: "(silêncio)" });

  it("maps media time onto the timeline through the clip start and take offset", () => {
    // Clip starts at 10 s on the timeline; its media starts at 4 s. A cut at 6–7 s of media
    // sits 2–3 s into the clip, so it lands at 12–13 s on the timeline.
    const result = toTimelineCuts([cut(6000, 7000)], { eventStartMs: 10000, eventLengthMs: 30000, sourceOffsetMs: 4000 });
    assert.deepEqual(result.cuts, [{ startMs: 12000, endMs: 13000, reasons: ["pause"], text: "(silêncio)" }]);
    assert.equal(result.skipped, 0);
  });

  it("drops cuts that fall entirely outside the clip and counts them", () => {
    const result = toTimelineCuts([cut(0, 1000), cut(50000, 51000)], { eventStartMs: 0, eventLengthMs: 10000, sourceOffsetMs: 4000 });
    assert.deepEqual(result.cuts, []);
    assert.equal(result.skipped, 2);
  });

  it("clips a cut that runs past either edge of the clip", () => {
    // Media 3–6 s with the clip covering media 4–14 s: only 4–6 s is inside.
    const result = toTimelineCuts([cut(3000, 6000)], { eventStartMs: 0, eventLengthMs: 10000, sourceOffsetMs: 4000 });
    assert.deepEqual(result.cuts.map((c) => [c.startMs, c.endMs]), [[0, 2000]]);
  });
});

describe("removalOrder", () => {
  it("puts the latest cut first so earlier positions stay valid", () => {
    const cuts: TimelineCut[] = [
      { startMs: 1000, endMs: 2000, reasons: [], text: "" },
      { startMs: 5000, endMs: 6000, reasons: [], text: "" },
      { startMs: 3000, endMs: 4000, reasons: [], text: "" },
    ];
    assert.deepEqual(removalOrder(cuts).map((c) => c.startMs), [5000, 3000, 1000]);
    assert.deepEqual(cuts.map((c) => c.startMs), [1000, 5000, 3000], "input is not reordered in place");
  });
});

describe("PlanStore", () => {
  const cuts: TimelineCut[] = [{ startMs: 1, endMs: 2, reasons: [], text: "" }];

  it("returns a plan once", () => {
    const store = new PlanStore();
    const plan = store.create(cuts);
    assert.deepEqual(store.take(plan.id).cuts, cuts);
    assert.throws(() => store.take(plan.id), /Unknown plan/);
  });

  it("refuses a plan after it expires", () => {
    let now = 0;
    const store = new PlanStore(() => now, 1000);
    const plan = store.create(cuts);
    now = 1001;
    assert.throws(() => store.take(plan.id), /expired/);
  });

  it("refuses an id it never issued", () => {
    assert.throws(() => new PlanStore().take("not-a-plan"), /Unknown plan/);
  });
});

describe("sendBridgeCommand", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vegas-mcp-bridge-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("explains how to start the bridge when no token exists", async () => {
    const previous = process.env.VEGAS_MCP_TOKEN_PATH;
    process.env.VEGAS_MCP_TOKEN_PATH = join(dir, "missing-token.txt");
    try {
      await assert.rejects(sendBridgeCommand("status"), (error: unknown) =>
        error instanceof BridgeError && /Tools > Scripting > Bridge/.test(error.message),
      );
    } finally {
      restore("VEGAS_MCP_TOKEN_PATH", previous);
    }
  });

  it("explains that the bridge is not running when nothing listens on the port", async () => {
    const tokenFile = join(dir, "token.txt");
    writeFileSync(tokenFile, "test-token", "utf-8");
    const previous = process.env.VEGAS_MCP_TOKEN_PATH;
    process.env.VEGAS_MCP_TOKEN_PATH = tokenFile;
    try {
      // Port 1 is never a listener on loopback, so the connection is refused straight away.
      await assert.rejects(sendBridgeCommand("status", { port: 1, timeoutMs: 5000 }), (error: unknown) =>
        error instanceof BridgeError && /not running|Could not reach/.test(error.message),
      );
    } finally {
      restore("VEGAS_MCP_TOKEN_PATH", previous);
    }
  });
});

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

describe("snapCutsToFrames", () => {
  it("shrinks a cut inward to the frame grid so no speech frame is taken", () => {
    // At 30 fps a frame is 33.333 ms. The cut starts on frame 31 and ends on frame 60.
    const { cuts, dropped } = snapCutsToFrames([{ startMs: 1000.5, endMs: 2000.2, reasons: ["pause"], text: "" }], 30);
    assert.equal(dropped, 0);
    assert.equal(cuts[0]!.startMs, 1033.333);
    assert.equal(cuts[0]!.endMs, 2000);
  });

  it("drops a cut that shrinks to nothing", () => {
    const { cuts, dropped } = snapCutsToFrames([{ startMs: 1010, endMs: 1020, reasons: ["pause"], text: "" }], 30);
    assert.deepEqual(cuts, []);
    assert.equal(dropped, 1);
  });
});

describe("expectedLengthAfter", () => {
  it("is the length minus every cut", () => {
    const cuts: TimelineCut[] = [
      { startMs: 1000, endMs: 2000, reasons: [], text: "" },
      { startMs: 5000, endMs: 5500, reasons: [], text: "" },
    ];
    assert.equal(expectedLengthAfter(10000, cuts), 8500);
  });
});

import { mergeTimelineCuts, selectClips, type TimelineSnapshot } from "../src/vegas/plan.js";

const SNAP: TimelineSnapshot = {
  tracks: [
    { index: 0, type: "video", events: [{ index: 0, startMs: 5000, lengthMs: 3000, grouped: false, takeOffsetMs: 0, mediaPath: "C:/a/overlay.mov" }] },
    {
      index: 1,
      type: "video",
      events: [
        { index: 0, startMs: 0, lengthMs: 20000, grouped: true, takeOffsetMs: 0, mediaPath: "C:/Users/example/Downloads/clip.mp4" },
        { index: 1, startMs: 20000, lengthMs: 59583, grouped: true, takeOffsetMs: 25000, mediaPath: "C:/Users/example/Downloads/clip.mp4" },
      ],
    },
    { index: 2, type: "audio", events: [{ index: 0, startMs: 0, lengthMs: 20000, grouped: true, takeOffsetMs: 0, mediaPath: "C:/Users/example/Downloads/clip.mp4" }] },
  ],
};

describe("selectClips", () => {
  it("finds every video clip that plays the transcribed media, whatever its track number", () => {
    const found = selectClips(SNAP, "C:/Users/example/Downloads/clip.mp4");
    assert.deepEqual(found.map((f) => [f.trackIndex, f.clip.index]), [[1, 0], [1, 1]]);
  });

  it("refuses a transcript for media nothing on the timeline plays", () => {
    assert.throws(() => selectClips(SNAP, "C:/nowhere/missing.mp4"), /No video clip on the timeline plays/);
  });

  it("uses an explicit track and event only when that clip plays the same media", () => {
    assert.deepEqual(selectClips(SNAP, "C:/Users/example/Downloads/clip.mp4", 1, 1).map((f) => f.clip.startMs), [20000]);
    assert.throws(() => selectClips(SNAP, "C:/Users/example/Downloads/clip.mp4", 0, 0), /overlay/);
  });
});

describe("mergeTimelineCuts", () => {
  it("joins cuts that overlap or touch, and keeps both reasons", () => {
    const merged = mergeTimelineCuts([
      { startMs: 1000, endMs: 2000, reasons: ["pause"], text: "(silencio)" },
      { startMs: 1500, endMs: 2500, reasons: ["silence"], text: "(silencio)" },
      { startMs: 3000, endMs: 3500, reasons: ["repeat"], text: "eu eu" },
    ]);
    assert.deepEqual(merged, [
      { startMs: 1000, endMs: 2500, reasons: ["pause", "silence"], text: "(silencio)" },
      { startMs: 3000, endMs: 3500, reasons: ["repeat"], text: "eu eu" },
    ]);
  });
});
