import type { HarnessExit } from '@atc/plugin-api';
import { z } from 'zod';

// What ended a process impd no longer holds: the kept previous generation
// of the same boot, and impd's cold boots, newest first. Each part is read
// on its own, and one that does not read is no evidence.
const LOST_BOOT_SCHEMA = z.object({ bootId: z.string() });
const LOST_PREVIOUS_SCHEMA = z.object({ previous: z.unknown() });
const LOST_COLD_BOOTS_SCHEMA = z.object({ coldBoots: z.array(z.unknown()) });
const GENERATION_SCHEMA = z.object({ executionGeneration: z.string() });
const EXIT_CODE_SCHEMA = z.object({ exitCode: z.number() });

// In the same boot, the kept previous generation gives the exit. Across a cold
// boot, the first boot after the daemon's own gives the cause, unknown when
// impd no longer lists the daemon's boot.
export function buildLostExit(
  data: unknown,
  cursor: Readonly<{ bootId: string; generation: string }> | null,
): HarnessExit {
  const bootID = LOST_BOOT_SCHEMA.safeParse(data).data?.bootId;
  const previous = LOST_PREVIOUS_SCHEMA.safeParse(data).data?.previous;

  if (cursor !== null && bootID === cursor.bootId) {
    const generation = GENERATION_SCHEMA.safeParse(previous);
    const exitCode = EXIT_CODE_SCHEMA.safeParse(previous);
    const isOwn = generation.data?.executionGeneration === cursor.generation;

    return isOwn
      ? { exitCode: exitCode.data?.exitCode ?? 1, reason: 'exited' }
      : { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' };
  }

  const boots = collectColdBoots(LOST_COLD_BOOTS_SCHEMA.safeParse(data).data?.coldBoots ?? []);
  const own = cursor === null ? -1 : boots.findIndex((boot) => boot.bootId === cursor.bootId);
  const next = own > 0 ? boots[own - 1] : undefined;

  return next === undefined
    ? { exitCode: 1, reason: 'ended', detail: 'ended, cause unknown' }
    : { exitCode: 1, reason: 'ended', detail: `imp rebooted (${next.cause})` };
}

// A boot whose id is not text still holds its place in the order.
const COLD_BOOT_SCHEMA = z.object({ bootId: z.unknown().optional() });
const CAUSE_SCHEMA = z.object({ cause: z.string() });

// impd's cold boots, newest first, as far as each one reads.
function collectColdBoots(
  entries: readonly unknown[],
): { readonly bootId: unknown; readonly cause: string }[] {
  return entries.flatMap((entry) => {
    const boot = COLD_BOOT_SCHEMA.safeParse(entry);
    const cause = CAUSE_SCHEMA.safeParse(entry);

    return boot.success
      ? [{ bootId: boot.data.bootId, cause: cause.data?.cause ?? 'unknown' }]
      : [];
  });
}
