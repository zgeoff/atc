import type { DroppedAnswer } from '../client/spawn-picker';

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
    showBase: (): void => {
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
