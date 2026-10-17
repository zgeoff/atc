import type { DaemonClient, EventMsg } from '@atc/protocol/wire';

export async function startStubTap(client: DaemonClient, session: string) {
  const messages: EventMsg[] = [];
  const closed: EventMsg[] = [];

  // An ack that a closing connection never answers changes nothing the
  // caller reads.
  const sendAck = async (message: unknown) => {
    try {
      await client.sendRequest('message.ack', { session, message });
    } catch {}
  };

  client.onEvent = (event) => {
    if (event.ev === 'InboxMessage') {
      messages.push(event);
      void sendAck(event['message']);
    }

    if (event.ev === 'InboxClosed') {
      closed.push(event);
    }
  };

  await client.sendRequest('session.tap', { session });

  return { messages, closed };
}
