/**
 * Rules for changing an event's fades and normalisation together. Measured on VEGAS Pro 2026.0.3
 * (189): an audio event that is both normalised and faded renders as silence, while either one
 * alone renders with sound. So a change that would create that pair is refused before VEGAS is
 * touched. Pure, so the rule is testable without VEGAS.
 */

export type AudioState = {
  fadeInMs: number;
  fadeOutMs: number;
  normalize: boolean;
};

export type AudioChange = {
  fadeInMs?: number;
  fadeOutMs?: number;
  normalize?: boolean;
};

/** The state the event would have after the change. */
export function stateAfter(current: AudioState, change: AudioChange): AudioState {
  return {
    fadeInMs: change.fadeInMs ?? current.fadeInMs,
    fadeOutMs: change.fadeOutMs ?? current.fadeOutMs,
    normalize: change.normalize ?? current.normalize,
  };
}

/** Null when the change is safe. Otherwise, the reason to refuse it, in words the user can act on. */
export function fadeNormalizeConflict(current: AudioState, change: AudioChange): string | null {
  const after = stateAfter(current, change);
  const faded = after.fadeInMs > 0 || after.fadeOutMs > 0;
  if (after.normalize && faded) {
    return (
      "This event would be both normalised and faded, and VEGAS renders that as silence. " +
      "Set its fades to 0 ms first, or turn normalisation off, and then make the other change."
    );
  }
  return null;
}
