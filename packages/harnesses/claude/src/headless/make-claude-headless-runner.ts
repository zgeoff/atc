import type { HeadlessRunEvents, HeadlessRunHandle, HeadlessRunner } from '@atc/plugin-api';
import type { ClaudeHeadlessRunRequest } from './build-claude-query-options';

export type ClaudeHeadlessRun = (
  opts: ClaudeHeadlessRunRequest,
  events: HeadlessRunEvents,
) => HeadlessRunHandle;

interface ClaudeHeadlessTarget {
  readonly claudeBin: string;
  readonly permissionMode: string;
  readonly pluginDir: () => string;

  readonly pluginDirs: readonly string[];
  readonly settings?: () => string;
}

export function makeClaudeHeadlessRunner(
  run: ClaudeHeadlessRun,
  target: ClaudeHeadlessTarget,
): HeadlessRunner {
  return (opts, events) => {
    const pluginDirs = [...target.pluginDirs, ...(opts.pluginDirs ?? [])];

    return run(
      {
        ...opts,
        ...(pluginDirs.length === 0 ? {} : { pluginDirs }),
        claudeBin: target.claudeBin,
        permissionMode: target.permissionMode,
        pluginDir: target.pluginDir(),
        ...(target.settings === undefined ? {} : { settings: target.settings() }),
      },
      events,
    );
  };
}
