import { buildSessionEnv } from '@atc/protocol/session';
import type { SessionEnv } from '@atc/protocol/session';

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
