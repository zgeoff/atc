import type { ExecConnection, ExecEnd, SpritesPort } from '../port/types';

export interface TrackedPort {
  readonly port: SpritesPort;

  readonly detachAll: (sprite: string) => void;
  readonly countAttached: (sprite: string) => number;
}

export function createTrackedPort(api: SpritesPort): TrackedPort {
  const attached = new Map<string, Set<() => void>>();

  const getAttached = (sprite: string): Set<() => void> => {
    const known = attached.get(sprite) ?? new Set<() => void>();

    attached.set(sprite, known);

    return known;
  };

  return {
    port: {
      ...api,
      openExec: (name, request) => {
        const inner = api.openExec(name, request);
        const endListeners: ((end: ExecEnd) => void)[] = [];
        const held = getAttached(name);
        let isOver = false;

        const finish = (end: ExecEnd | null): void => {
          if (isOver) {
            return;
          }

          isOver = true;

          held.delete(forceEnd);

          if (end !== null) {
            for (const listener of endListeners) {
              listener(end);
            }
          }
        };

        const forceEnd = (): void => {
          if (!isOver) {
            inner.detach();

            finish({ kind: 'dropped' });
          }
        };

        held.add(forceEnd);
        inner.onEnd(finish);

        const connection: ExecConnection = {
          ...inner,
          onEnd: (listener) => {
            endListeners.push(listener);
          },
          detach: () => {
            if (!isOver) {
              inner.detach();

              finish(null);
            }
          },
        };

        return connection;
      },
    },

    detachAll: (sprite) => {
      for (const forceEnd of attached.get(sprite) ?? []) {
        forceEnd();
      }
    },

    countAttached: (sprite) => attached.get(sprite)?.size ?? 0,
  };
}
