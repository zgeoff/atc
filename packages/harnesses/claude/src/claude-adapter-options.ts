import type { ClaudeHostPaths } from './claude-host-paths';
import type { ClaudeHeadlessRun } from './headless/make-claude-headless-runner';

export interface ClaudeAdapterOptions extends ClaudeHostPaths {
  readonly headlessRun?: ClaudeHeadlessRun | null;
  readonly bridgeTarget?: string;
}
