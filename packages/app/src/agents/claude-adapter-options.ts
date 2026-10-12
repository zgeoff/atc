import type { ClaudeHostPaths } from './claude-host-paths';
import type { ClaudeHeadlessRun } from './make-claude-headless-runner';

/**
 * What a Claude-family adapter takes besides its entry and the host: the
 * headless turn it runs, null or absent for none, the folder it writes its
 * copy of the atc-bridge mod to, absent for the one in atc's state folder,
 * and the folders it writes its settings to and reads the user's Claude
 * config from.
 */
export interface ClaudeAdapterOptions extends ClaudeHostPaths {
  readonly headlessRun?: ClaudeHeadlessRun | null;
  readonly bridgeTarget?: string;
}
