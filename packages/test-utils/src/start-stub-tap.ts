import type { DaemonEvent } from '@atc/protocol';
import type { DaemonClient } from '@atc/protocol/client';

interface StubTapOptions {
  // Whether the tap also takes the answer notices of the messages the session
  // sent, as the bridge's tap does; it takes none when absent.
  readonly notices?: boolean;
}

export async function startStubTap(
  client: DaemonClient,
  session: string,
  options: StubTapOptions = {},
) {
  const messages: Extract<DaemonEvent, { ev: 'InboxMessage' }>[] = [];
  const notices: Extract<DaemonEvent, { ev: 'InboxNotice' }>[] = [];
  const closed: Extract<DaemonEvent, { ev: 'InboxClosed' }>[] = [];

  // An ack that a closing connection never answers changes nothing the
  // caller reads.
  const sendAck = async (method: string, message: unknown) => {
    try {
      await client.sendRequest(method, { session, message });
    } catch {}
  };

  client.onEvent = (event) => {
    if (event.ev === 'InboxMessage') {
      messages.push(event);
      void sendAck('message.ack', event.message);
    }

    if (event.ev === 'InboxNotice') {
      notices.push(event);
      void sendAck('notice.ack', event.message);
    }

    if (event.ev === 'InboxClosed') {
      closed.push(event);
    }
  };

  const tapParams = options.notices === true ? { session, notices: true } : { session };

  await client.sendRequest('session.tap', tapParams);

  return { messages, notices, closed };
}
