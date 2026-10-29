import type { Clock } from '@atc/core';

// How often an open socket pings impd.
const PING_INTERVAL_MS = 10_000;

// How long an open socket may hear nothing from impd, pongs included, before
// it ends.
const SILENCE_LIMIT_MS = 30_000;

// A network path that drops every packet leaves a socket open with nothing
// to read, and impd's own ping timeout closes only impd's side, so only a
// ping from this side ends it.
export function watchSocketLiveness(socket: WebSocket, clock: Clock): WebSocket {
  const state: { heardAt: number; cancel: (() => void) | null } = {
    heardAt: clock.now(),
    cancel: null,
  };

  const hear = (): void => {
    state.heardAt = clock.now();
  };

  const checkLiveness = (): void => {
    state.cancel = null;

    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (clock.now() - state.heardAt >= SILENCE_LIMIT_MS) {
      socket.terminate();

      return;
    }

    socket.ping();

    state.cancel = clock.schedule(checkLiveness, PING_INTERVAL_MS);
  };

  socket.addEventListener('open', () => {
    hear();

    state.cancel = clock.schedule(checkLiveness, PING_INTERVAL_MS);
  });

  socket.addEventListener('message', hear);
  socket.addEventListener('pong', hear);

  socket.addEventListener('close', () => {
    state.cancel?.();
    state.cancel = null;
  });

  return socket;
}
