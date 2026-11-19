import type { EngineInterface } from 'claude-code';
import type { TapMessage, TapNotice } from './parse-tap-line.ts';

interface StepHold {
  readonly ended: Promise<void>;
  readonly end: () => void;
}

// The plugin validator follows the engine's `$` only inside the entry file.
export interface BridgeHost {
  readonly process: {
    readonly run: EngineInterface['process']['run'];
    readonly spawn: EngineInterface['process']['spawn'];
  };
  readonly ui: { readonly log: EngineInterface['ui']['log'] };
  readonly clock: { readonly sleep: EngineInterface['clock']['sleep'] };
  readonly prompt: { readonly submit: EngineInterface['prompt']['submit'] };
  readonly session: { readonly append: EngineInterface['session']['append'] };
}

export interface BridgeState {
  sessionID: string | null;
  runningTurnID: string | null;
  // A row appended between two streaming blocks puts a server tool call and its result in separate assistant messages, and the API then refuses every later request.
  stepHold: StepHold | null;
  delivering: Promise<void>;
  reporting: Promise<void>;
  // A turn that ends without an answer leaves a submitted message waiting, because the host can still run its queued prompt;
  // only a hook's drop shows it never will.
  readonly awaitingTurn: Map<string, TapMessage>;
  readonly carried: Map<string, TapMessage[]>;
  readonly unseen: Set<string>;
  readonly unseenNotices: Map<string, TapNotice[]>;
  readonly shownNotices: Set<string>;
}

// A command left in the session's working folder, which follows the agent's cd, fails with
// ENOENT on the atc binary once the agent removes that folder, as when it cleans up a worktree.
export const ATC_CWD = '/';
