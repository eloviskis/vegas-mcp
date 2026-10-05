import { createHash, randomUUID } from "node:crypto";

/**
 * A stable fingerprint of the timeline as the bridge reported it. A plan made against one
 * timeline must not be applied to another, because the cut positions would point at the wrong
 * place.
 */
export function timelineFingerprint(timeline: unknown): string {
  return createHash("sha256").update(JSON.stringify(timeline)).digest("hex");
}

/** Windows paths differ in case and slash direction; compare them as the same file when they match. */
export function sameMediaFile(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase().trim();
  return norm(a) === norm(b);
}

/**
 * Turns speech cuts (media time) into timeline cuts, and holds them as plans the user must
 * approve before anything changes in VEGAS. Pure, so the arithmetic and the approval rules are
 * testable without VEGAS.
 */

export type EventRef = {
  /** Where the clip starts on the timeline. */
  eventStartMs: number;
  /** How long the clip is on the timeline. */
  eventLengthMs: number;
  /** Media time that plays at the start of the clip (the take's offset). */
  sourceOffsetMs: number;
};

export type MediaCut = { startMs: number; endMs: number; reasons: string[]; text: string };

export type TimelineCut = { startMs: number; endMs: number; reasons: string[]; text: string };

/**
 * timeline = eventStart + (media − sourceOffset). Cuts outside the clip are dropped, and cuts
 * that run past its edges are clipped, so nothing outside the clip is ever removed.
 */
export function toTimelineCuts(cuts: MediaCut[], ref: EventRef): { cuts: TimelineCut[]; skipped: number } {
  const out: TimelineCut[] = [];
  let skipped = 0;

  for (const cut of cuts) {
    const start = Math.max(0, cut.startMs - ref.sourceOffsetMs);
    const end = Math.min(ref.eventLengthMs, cut.endMs - ref.sourceOffsetMs);
    if (end <= start) {
      skipped++;
      continue;
    }
    out.push({
      startMs: ref.eventStartMs + start,
      endMs: ref.eventStartMs + end,
      reasons: cut.reasons,
      text: cut.text,
    });
  }
  return { cuts: out, skipped };
}

export type TimelineClip = {
  index: number;
  startMs: number;
  lengthMs: number;
  grouped: boolean;
  takeOffsetMs: number;
  mediaPath?: string;
};

export type TimelineSnapshot = {
  tracks: Array<{ index: number; type: string; events: TimelineClip[] }>;
};

/**
 * The video clips that play the transcribed media. Track numbers change when tracks are added
 * above, so clips are found by their media, not by position. An explicit track and event still
 * work, but only if that clip plays the same media. Pure.
 */
export function selectClips(
  timeline: TimelineSnapshot,
  mediaPath: string | undefined,
  trackIndex?: number,
  eventIndex?: number,
): Array<{ trackIndex: number; clip: TimelineClip }> {
  if (trackIndex !== undefined || eventIndex !== undefined) {
    const t = trackIndex ?? 0;
    const e = eventIndex ?? 0;
    const clip = timeline.tracks.find((track) => track.index === t)?.events.find((ev) => ev.index === e);
    if (!clip) {
      throw new Error(`No clip at track ${t}, event ${e}. Run vegas_list_timeline to see the indexes.`);
    }
    if (!sameMediaFile(clip.mediaPath, mediaPath)) {
      throw new Error(
        `That clip plays "${clip.mediaPath ?? "unknown"}", but the transcript is for "${mediaPath ?? "unknown"}". Use the clip's own transcript.`,
      );
    }
    return [{ trackIndex: t, clip }];
  }

  const matches: Array<{ trackIndex: number; clip: TimelineClip }> = [];
  for (const track of timeline.tracks) {
    if (track.type !== "video") continue;
    for (const clip of track.events) {
      if (sameMediaFile(clip.mediaPath, mediaPath)) matches.push({ trackIndex: track.index, clip });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `No video clip on the timeline plays "${mediaPath ?? "unknown"}". Import that media into VEGAS, or transcribe the media the timeline actually plays.`,
    );
  }
  return matches;
}

/**
 * Joins cuts that overlap or touch. One transcript can map onto several events of the same
 * media, and two of them may cut the same stretch; removing a stretch twice would take speech
 * that was meant to stay. Pure.
 */
export function mergeTimelineCuts(cuts: TimelineCut[]): TimelineCut[] {
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs);
  const merged: TimelineCut[] = [];
  for (const cut of sorted) {
    const last = merged[merged.length - 1];
    if (last && cut.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cut.endMs);
      for (const reason of cut.reasons) {
        if (!last.reasons.includes(reason)) last.reasons.push(reason);
      }
      if (cut.text && !last.text.includes(cut.text)) last.text = [last.text, cut.text].filter(Boolean).join(" ");
    } else {
      merged.push({ ...cut, reasons: [...cut.reasons] });
    }
  }
  return merged;
}

/**
 * Puts each cut on the project's frame grid. The cut shrinks inward: it starts on the first
 * frame boundary at or after the start, and ends on the last boundary at or before the end. So
 * a cut never takes a frame of speech that was not already silent. Cuts that vanish are dropped.
 */
export function snapCutsToFrames(cuts: TimelineCut[], fps: number): { cuts: TimelineCut[]; dropped: number } {
  const frame = 1000 / fps;
  const out: TimelineCut[] = [];
  let dropped = 0;
  for (const cut of cuts) {
    const startMs = Math.ceil(cut.startMs / frame) * frame;
    const endMs = Math.floor(cut.endMs / frame) * frame;
    if (endMs <= startMs) {
      dropped++;
      continue;
    }
    out.push({ ...cut, startMs: Math.round(startMs * 1000) / 1000, endMs: Math.round(endMs * 1000) / 1000 });
  }
  return { cuts: out, dropped };
}

/** Total length the timeline should have once these cuts are removed. */
export function expectedLengthAfter(beforeMs: number, cuts: TimelineCut[]): number {
  const removed = cuts.reduce((sum, c) => sum + (c.endMs - c.startMs), 0);
  return Math.round((beforeMs - removed) * 10) / 10;
}

/** Latest cut first. Removing a later range does not move earlier ones, so each cut keeps the
 * position it was planned at.
 */
export function removalOrder(cuts: TimelineCut[]): TimelineCut[] {
  return [...cuts].sort((a, b) => b.startMs - a.startMs);
}

export type Plan = {
  id: string;
  createdAt: number;
  expiresAt: number;
  cuts: TimelineCut[];
  /** timelineFingerprint() of the timeline the cuts were computed from. */
  fingerprint: string;
};

/**
 * Plans are kept in memory for the life of the MCP server. Each one expires and can be applied
 * only once, so an approval cannot be replayed later against a different timeline.
 */
export class PlanStore {
  private readonly plans = new Map<string, Plan>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = 30 * 60_000,
  ) {}

  create(cuts: TimelineCut[], fingerprint = ""): Plan {
    const createdAt = this.now();
    const plan: Plan = {
      id: randomUUID(),
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      cuts,
      fingerprint,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Returns the plan and removes it. Throws if it is unknown, used, or expired. */
  take(id: string): Plan {
    const plan = this.plans.get(id);
    if (!plan) {
      throw new Error("Unknown plan. Create one with vegas_plan_cuts; plans are not reusable.");
    }
    this.plans.delete(id);
    if (this.now() > plan.expiresAt) {
      throw new Error("This plan expired. Create a new one with vegas_plan_cuts.");
    }
    return plan;
  }
}
