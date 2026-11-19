import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { HeadlessRunRequest } from '@atc/plugin-api';
import { CLAUDE_EFFORT_LEVELS } from '../launch-args/claude-effort-levels';
import { buildHeadlessEnv } from './build-headless-env';
import { resolveHeadlessExecutable } from './resolve-headless-executable';

export interface ClaudeHeadlessRunRequest extends HeadlessRunRequest {
  readonly claudeBin: string;

  readonly permissionMode?: string;

  readonly settings?: string;

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
  const mode = PERMISSION_MODES.find((permissionMode) => permissionMode === opts.permissionMode);
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

    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(effort === undefined ? {} : { effort }),

    ...(opts.pluginDirs === undefined || opts.pluginDirs.length === 0
      ? {}
      : {
          plugins: [...new Set(opts.pluginDirs)].map((path) => ({ type: 'local' as const, path })),
        }),

    ...(opts.settings === undefined ? {} : { extraArgs: { settings: opts.settings } }),
    ...resolveHeadlessExecutable(opts.claudeBin, compiled),
  };
}
