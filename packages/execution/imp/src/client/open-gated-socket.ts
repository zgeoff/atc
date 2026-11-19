// The client sends the request as the socket's first message and holds every other message
// until then, so gating the first send gates the whole exchange.
export function openGatedSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
  gate: (() => boolean) | undefined,
): WebSocket {
  const socket = new WebSocket(url, { headers });

  if (gate === undefined) {
    return socket;
  }

  const send = socket.send.bind(socket);
  const state: { passed: boolean | null } = { passed: null };

  socket.send = (data) => {
    if (state.passed === null) {
      state.passed = tryPassGate(gate);

      if (!state.passed) {
        socket.close(1000, 'closed before sending');
      }
    }

    if (state.passed) {
      send(data);
    }
  };

  return socket;
}

function tryPassGate(gate: () => boolean): boolean {
  try {
    return gate();
  } catch {
    return false;
  }
}
