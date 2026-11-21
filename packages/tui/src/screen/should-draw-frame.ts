export interface FrameDrawState {
  readonly isScreenWriting: boolean;
  readonly isStreamSettled: boolean;
  readonly isReplaying: boolean;

  // when the first frame that found the session output parsing was asked for, or null
  readonly waitingSinceMs: number | null;
  readonly nowMs: number;
}

// one frame at 60 Hz
const MAX_WAIT_MS = 16;

// A frame waits for the emulators to finish parsing, so it shows no screen halfway through a
// chunk. A session that writes without a pause keeps a write in flight, so a frame waits at most one
// frame for its output. A replay never draws before it is whole.
export function shouldDrawFrame(state: FrameDrawState): boolean {
  if (state.isScreenWriting || state.isReplaying) {
    return false;
  }

  if (state.isStreamSettled) {
    return true;
  }

  return state.waitingSinceMs !== null && state.nowMs - state.waitingSinceMs >= MAX_WAIT_MS;
}
