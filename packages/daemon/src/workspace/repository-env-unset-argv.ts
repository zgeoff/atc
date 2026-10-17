import { REPOSITORY_ENV_VARS } from './repository-env-vars';

export const REPOSITORY_ENV_UNSET_ARGV: readonly string[] = [
  'env',
  ...[...REPOSITORY_ENV_VARS].flatMap((name) => ['-u', name]),
];
