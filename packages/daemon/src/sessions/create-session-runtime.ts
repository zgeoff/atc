import type { ScreenMenu } from '@atc/plugin-api';
import type { Dims } from './create-attach-registry';
import type { ScreenModel } from './create-screen-model';
import { createSessionInputQueue } from './create-session-input-queue';
import type { SessionInputQueue } from './create-session-input-queue';

interface HeadlessRunHandle {
  readonly stop: () => void;
}

export interface SessionRuntime {
  screen: ScreenModel | null;

  seq: number;

  lastOutputAt: number;

  wholeMenu: ScreenMenu | null;

  dims: Dims | null;

  readonly input: SessionInputQueue;

  cancelResize: (() => void) | undefined;

  cancelDetect: (() => void) | undefined;

  headlessRun: HeadlessRunHandle | null;

  // The runner reports no exit, and a turn's result or stop arrives before its process ends.
  // The process may still run in the session's folders.
  headlessStarted: boolean;

  pendingEject: (() => void) | null;

  bootWaiter: (() => void) | null;

  pendingLastUsed: boolean;

  startedAt: number | null;

  // No hook report closes a needs_you set from the screen, since the agent
  // runs no hook before its start.
  needsYouFromScreen: boolean;

  doneMsgUnderScreen: string | null;

  needsInputUnrecorded: boolean;

  // Whether a tap has attached since the terminal last booted. A tap that
  // later dropped may be restarting, so it keeps the inbox open.
  tapAttached: boolean;

  hasAgentHookLines: boolean;

  harnessState: unknown;

  readonly resetBoot: (dims: Dims) => void;

  readonly dispose: () => void;

  readonly stopHeadlessRun: () => void;
}

export function createSessionRuntime(): SessionRuntime {
  const runtime: SessionRuntime = {
    screen: null,

    seq: 0,

    lastOutputAt: 0,

    wholeMenu: null,

    dims: null,

    input: createSessionInputQueue(),

    cancelResize: undefined,

    cancelDetect: undefined,

    headlessRun: null,

    headlessStarted: false,

    pendingEject: null,

    bootWaiter: null,

    pendingLastUsed: false,

    startedAt: null,

    needsYouFromScreen: false,

    doneMsgUnderScreen: null,

    needsInputUnrecorded: false,

    tapAttached: false,

    hasAgentHookLines: false,

    harnessState: undefined,

    resetBoot: (dims) => {
      runtime.dims = dims;
      runtime.startedAt = null;
      runtime.needsYouFromScreen = false;
      runtime.doneMsgUnderScreen = null;
      runtime.needsInputUnrecorded = false;
      runtime.tapAttached = false;
      runtime.hasAgentHookLines = false;
      runtime.harnessState = undefined;
      runtime.wholeMenu = null;
    },

    dispose: () => {
      runtime.cancelResize?.();
      runtime.cancelDetect?.();
      runtime.cancelResize = undefined;
      runtime.cancelDetect = undefined;
      runtime.screen?.stop();
      runtime.screen = null;

      runtime.stopHeadlessRun();
      runtime.pendingEject?.();
      runtime.pendingEject = null;
      runtime.bootWaiter?.();
      runtime.bootWaiter = null;
    },

    stopHeadlessRun: () => {
      runtime.headlessRun?.stop();
      runtime.headlessRun = null;
    },
  };

  return runtime;
}
