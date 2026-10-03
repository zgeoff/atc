import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { socketPath } from '../shared/config';
import type { HeadlessRunRequest } from './agent-adapter';
import { buildHeadlessEnv } from './build-headless-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

/**
 * One headless turn as the Claude CLI runs it: the neutral turn request plus
 * the binary, permission mode, mod folder, and settings file the Claude and
 * gateway adapters supply.
 */
export interface ClaudeHeadlessRunRequest extends HeadlessRunRequest {
  // The Claude Code binary a compiled atc hands the Agent SDK.
  readonly claudeBin: string;

  // An SDK permission mode; any other value leaves the SDK's default.
  readonly permissionMode?: string;

  // Settings file the run's CLI is started with, so a headless turn reaches
  // the same backend the session's terminal did.
  readonly settings?: string;

  // Folder of the atc-bridge mod the run's CLI loads.
  readonly pluginDir?: string;
}

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'auto',
  'dontAsk',
] as const;

// The effort levels the Agent SDK accepts.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/**
 * The Agent SDK options one headless turn runs with, apart from the abort
 * controller and stderr sink the live run owns. A permission mode or effort
 * the SDK does not accept is left out, so the SDK applies its own default.
 */
export function buildClaudeQueryOptions(
  opts: ClaudeHeadlessRunRequest,
  compiled: boolean,
): Options {
  const mode = PERMISSION_MODES.find((m) => m === opts.permissionMode);
  const effort = EFFORT_LEVELS.find((level) => level === opts.effort);

  return {
    cwd: opts.cwd,
    env: buildHeadlessEnv({
      socketPath,
      ...(opts.pluginDir === undefined ? {} : { pluginDir: opts.pluginDir }),
      ...(opts.sessionID === undefined ? {} : { sessionID: opts.sessionID }),
      ...(opts.withheldEnv === undefined ? {} : { withheldEnv: opts.withheldEnv }),
    }),
    ...(opts.resume === undefined ? {} : { resume: opts.resume }),
    ...(mode === undefined ? {} : { permissionMode: mode }),

    // The session's own model and effort, so the turn runs as its terminal
    // did.
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(effort === undefined ? {} : { effort }),

    // The same generated file the terminal spawn passes, so the turn runs
    // against the session's own backend and instrumentation.
    ...(opts.settings === undefined ? {} : { extraArgs: { settings: opts.settings } }),
    ...resolveHeadlessExecutable(opts.claudeBin, compiled),
  };
}
