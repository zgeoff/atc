import { DaemonError } from '@atc/protocol/wire';
import { z } from 'zod';

// impd's refusal to suspend a leased imp carries the leases the caller may see and a count
// of the others; each part is parsed on its own, so this reads only the list.
const LEASES_SCHEMA = z.object({ leases: z.array(z.unknown()) });
const OTHER_COUNT_SCHEMA = z.object({ otherCount: z.number() });

export function buildLeasedRefusal(name: string, data: unknown): DaemonError {
  const leases = LEASES_SCHEMA.safeParse(data).data?.leases ?? [];
  const otherCount = OTHER_COUNT_SCHEMA.safeParse(data).data?.otherCount ?? 0;

  return new DaemonError(
    'host_leased',
    `imp ${name} stays awake: another owner holds a lease on it, and atc never forces a sleep`,
    { leases, otherCount },
  );
}
