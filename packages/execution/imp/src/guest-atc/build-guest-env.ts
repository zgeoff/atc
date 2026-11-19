import { SESSION_ENV_NAMES } from '@atcx/contract/light';

// The PATH a guest harness runs with: the guest's standard one, never the
// daemon's.
const GUEST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// The daemon's reporter socket path means nothing inside the imp, so the guest never gets it.
export function buildGuestEnv(env: Readonly<Record<string, string>>): Record<string, string> {
  const own = Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== SESSION_ENV_NAMES.socket),
  );

  return { TERM: 'xterm-256color', LANG: 'C.UTF-8', PATH: GUEST_PATH, ...own };
}
