// The earliest time any layer asks for, or null when every layer is still.
export function pickNextFrameAt(answers: readonly (number | null)[]): number | null {
  let earliest: number | null = null;

  for (const answer of answers) {
    if (answer !== null && (earliest === null || answer < earliest)) {
      earliest = answer;
    }
  }

  return earliest;
}

// A tick that fires more than one frame after its due time is dropped, never queued.
export function isLateTick(dueAtMs: number, nowMs: number, frameMs: number): boolean {
  return nowMs - dueAtMs > frameMs;
}
