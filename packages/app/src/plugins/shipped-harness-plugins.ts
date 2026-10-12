import type { HarnessPlugin } from '@atc/config/agent-entry';
import { buildHarnessPlugins } from './build-harness-plugins';

/**
 * The harness plugins atc ships, on their default options: what reading
 * config takes.
 */
export const SHIPPED_HARNESS_PLUGINS: readonly HarnessPlugin[] = buildHarnessPlugins();
