import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSessionID } from '../shared/agent-session-id';
import { socketPath } from '../shared/config';
import type { SessionID } from '../shared/session-id';
import { buildHeadlessEnv } from './build-headless-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

export interface HeadlessRunOptions {
  readonly claudeBin: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly resume?: AgentSessionID;
  readonly permissionMode?: string;
  readonly settings?: string;
  readonly sessionID?: SessionID;
  readonly pluginDir?: string;
  readonly model?: string;
  readonly effort?: string;
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
export function buildHeadlessQueryOptions(opts: HeadlessRunOptions, compiled: boolean): Options {
  const mode = PERMISSION_MODES.find((m) => m === opts.permissionMode);
  const effort = EFFORT_LEVELS.find((level) => level === opts.effort);

  return {
    cwd: opts.cwd,
    env: buildHeadlessEnv({
      socketPath,
      ...(opts.pluginDir === undefined ? {} : { pluginDir: opts.pluginDir }),
      ...(opts.sessionID === undefined ? {} : { sessionID: opts.sessionID }),
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
