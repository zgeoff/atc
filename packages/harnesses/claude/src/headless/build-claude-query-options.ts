import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { HeadlessRunRequest } from '@atc/plugin-api';
import { CLAUDE_EFFORT_LEVELS } from '../claude-effort-levels';
import { buildHeadlessEnv } from './build-headless-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

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

export function buildClaudeQueryOptions(
  opts: ClaudeHeadlessRunRequest,
  compiled: boolean,
): Options {
  const mode = PERMISSION_MODES.find((m) => m === opts.permissionMode);
  const effort = CLAUDE_EFFORT_LEVELS.find((level) => level === opts.effort);

  return {
    cwd: opts.cwd,
    env: buildHeadlessEnv({
      socketPath: opts.reporterSocket,
      ...(opts.pluginDir === undefined ? {} : { pluginDir: opts.pluginDir }),
      ...(opts.sessionID === undefined ? {} : { sessionID: opts.sessionID }),
      ...(opts.withheldEnv === undefined ? {} : { withheldEnv: opts.withheldEnv }),
      ...(opts.recordPath === undefined ? {} : { recordPath: opts.recordPath }),
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
