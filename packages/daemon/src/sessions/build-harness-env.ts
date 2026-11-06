import { buildSessionEnv } from '@atc/protocol/session';
import type { SessionEnv } from '@atc/protocol/session';

// The local provider lays a harness's environment over the daemon's, less
// the withheld variables; a guest takes none of the daemon's, so a remote
// caller passes an empty daemon environment.
interface InheritedEnv {
  readonly daemonEnv: Readonly<Record<string, string | undefined>>;
  readonly withheldEnv: readonly string[];
}

export function buildHarnessEnv(
  planEnv: Readonly<Record<string, string>>,
  session: SessionEnv,
  inherited: InheritedEnv,
): Record<string, string> {
  const withheld = new Set(inherited.withheldEnv);

  const daemonEnv = Object.fromEntries(
    Object.entries(inherited.daemonEnv).filter(([key]) => !withheld.has(key)),
  );

  return {
    ...planEnv,
    ...buildSessionEnv({ ...session, inheritedEnv: { ...daemonEnv, ...planEnv } }),
  };
}
