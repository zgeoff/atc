import type { DroppedAnswer } from '../client/spawn-picker';

/**
 * The client a spawn picker runs inside, reduced to the reactions it
 * records: `counts` holds how many times the picker asked for a status
 * draw, returned to the screen the flow came from, attached a session, and
 * dropped an answer, and `dropped` holds the kind of each dropped answer
 * in order. `countReactions` returns the sum of every count, for a daemon
 * stand-in that waits on the picker to react. Attaching resolves at once.
 */
export function buildStubPickerHost() {
  const counts = { renders: 0, exits: 0, attached: 0, drops: 0 };
  const dropped: DroppedAnswer[] = [];

  return {
    counts,
    dropped,
    countReactions: (): number => counts.renders + counts.exits + counts.attached + counts.drops,
    scheduleStatus: (): void => {
      counts.renders += 1;
    },
    toBase: (): void => {
      counts.exits += 1;
    },
    attach: (): Promise<void> => {
      counts.attached += 1;

      return Promise.resolve();
    },
    onDropAnswer: (kind: DroppedAnswer): void => {
      counts.drops += 1;

      dropped.push(kind);
    },
  };
}
