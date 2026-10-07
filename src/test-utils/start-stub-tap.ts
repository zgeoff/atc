import type { DaemonClient } from '../client/daemon-client';
import type { EventMsg } from '../protocol/protocol';

/**
 * Makes the client the session's tap and acks each message the tap is
 * handed, the way an agent's inbox reader does, so the daemon drains the
 * whole backlog one message per ack. `messages` holds each InboxMessage in
 * the order it arrived and `closed` each InboxClosed. The client's event
 * callback is replaced.
 */
// oxlint-disable-next-line prefer-readonly-parameter-types -- a client is a live connection the tap drives
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
