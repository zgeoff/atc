import { REPOSITORY_ENV_VARS } from './repository-env-vars';

/**
 * An `env` prefix that unsets every variable pinning git to another
 * repository, so the command after it acts on its own working directory.
 */
export const REPOSITORY_ENV_UNSET_ARGV: readonly string[] = [
  'env',
  ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name]),
];
