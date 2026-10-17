import type { HarnessPlugin } from '@atc/config';
import { buildHarnessPlugins } from './build-harness-plugins';

// reading config needs none of the adapter options.
export const SHIPPED_HARNESS_PLUGINS: readonly HarnessPlugin[] = buildHarnessPlugins();
