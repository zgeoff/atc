import type { TapMessage, TapNotice } from './parse-tap-line.ts';

// Settles when the main loop's response, and every server tool call in it,
// has ended.
interface StepHold {
  readonly ended: Promise<void>;
  readonly end: () => void;
}

export interface BridgeState {
  sessionID: string | null;
  runningTurnID: string | null;
  // Claude Code records each streaming block once it ends. A row appended between two blocks
  // puts a server tool call and its result in separate assistant messages, and the API then
  // refuses every later request, so a delivery waits while this is set.
  stepHold: StepHold | null;
  delivering: Promise<void>;
  reporting: Promise<void>;
  // A submitted message waits here until the turn that carries it starts. Another turn that
  // ends without an answer leaves it waiting, because the host can still run its queued prompt;
  // only a hook's drop shows it never will.
  readonly awaitingTurn: Map<string, TapMessage>;
  readonly carried: Map<string, TapMessage[]>;
  readonly unseen: Set<string>;
  // The answer notices appended to each running turn that no step of the turn
  // has shown the model yet; a step empties the list.
  readonly unseenNotices: Map<string, TapNotice[]>;
  // The ids of the answer notices already in the conversation, so a notice the tap prints again
  // never shows twice.
  readonly shownNotices: Set<string>;
}

// A command left in the session's working folder, which follows the agent's cd, fails with
// ENOENT on the atc binary once the agent removes that folder, as when it cleans up a worktree.
export const ATC_CWD = '/';
