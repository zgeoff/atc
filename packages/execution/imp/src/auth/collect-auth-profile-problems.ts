import type { AuthProfile } from '@atc/plugin-api';

// impd's secret name rule: an imp name's form, so a secret name is never a
// path or a flag.
const SECRET_NAME = /^[a-z][a-z0-9-]{0,30}$/u;

// impd's header name rule.
const HEADER_NAME = /^[a-z0-9-]{1,64}$/u;

// Every profile in the config, not only the ones the target's sessions
// select, since any session on the target may select any of them.
export function collectAuthProfileProblems(
  targetID: string,
  profiles: ReadonlyMap<string, AuthProfile>,
): string[] {
  const problems: string[] = [];

  for (const profile of profiles.values()) {
    const where = `target ${JSON.stringify(targetID)} cannot use authProfiles.${profile.name}`;

    if (!SECRET_NAME.test(profile.secret)) {
      problems.push(
        `${where}: its secret must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens, the secret names impd accepts`,
      );
    }

    if (profile.kind !== 'github' && !HEADER_NAME.test(profile.header)) {
      problems.push(
        `${where}: its header must be up to 64 lowercase letters, digits or hyphens, the header names impd accepts`,
      );
    }
  }

  return problems;
}
