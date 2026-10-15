import type {
  BridgedMessage,
  MessageBridgeHost,
  MessageBridgeTap,
  UnsettledMessage,
} from '@atc/plugin-api';

type StubMessageStatus = 'queued' | 'delivered' | 'answered' | 'unanswered';

/**
 * A stand-in for the daemon's side of a message bridge, holding one
 * session's messages in memory with the daemon's statuses. Like the
 * daemon, it hands an attached tap the oldest queued message it has not
 * handed that tap, one at a time, the next after the ack before it; an
 * answer or unanswered note settles only a queued or delivered message;
 * and a note payload it cannot read is refused. `queueMessage` queues a
 * new message. `statuses` holds each message's status, `notes` each note
 * payload in order, `attaches` the count of taps attached, and `logs`
 * each log line.
 */
export function buildStubMessageBridgeHost(initial: readonly UnsettledMessage[] = []) {
  const statuses = new Map<string, StubMessageStatus>(initial.map((m) => [m.id, m.status]));
  const texts = new Map<string, BridgedMessage>();

  const notes: Readonly<Record<string, unknown>>[] = [];
  const logs: string[] = [];
  let tap: MessageBridgeTap | null = null;

  let handed = new Set<string>();

  let attaches = 0;

  const drain = () => {
    const current = tap;

    if (current === null) {
      return;
    }

    const next = [...statuses].find(([id, status]) => status === 'queued' && !handed.has(id));

    if (next === undefined) {
      return;
    }

    handed.add(next[0]);
    current.takeMessage(texts.get(next[0]) ?? { id: next[0], from: 'stub', text: '' });
  };

  const updateStatuses = (ids: readonly unknown[], status: 'answered' | 'unanswered') => {
    for (const id of ids) {
      const current = typeof id === 'string' ? statuses.get(id) : undefined;

      if (typeof id === 'string' && (current === 'queued' || current === 'delivered')) {
        statuses.set(id, status);
      }
    }
  };

  const host: MessageBridgeHost = {
    attachTap: (attached) => {
      tap = attached;

      handed = new Set();

      attaches += 1;

      drain();

      return true;
    },
    detachTap: (detached) => {
      if (tap === detached) {
        tap = null;
      }
    },
    ackMessage: (id) => {
      if (statuses.get(id) === 'queued') {
        statuses.set(id, 'delivered');
      }

      drain();

      return Promise.resolve();
    },
    ackNotice: () => Promise.resolve(),
    applyNote: (payload) => {
      const ids = Array.isArray(payload['messages']) ? payload['messages'] : [payload['message']];

      if (payload['kind'] === 'answered') {
        updateStatuses(ids, 'answered');
      } else if (payload['kind'] === 'unanswered') {
        updateStatuses(ids, 'unanswered');
      } else if (payload['kind'] !== 'note') {
        return Promise.resolve(false);
      }

      notes.push(payload);

      return Promise.resolve(true);
    },
    collectUnsettledMessages: () =>
      Promise.resolve(
        [...statuses]
          .filter(
            (entry): entry is [string, 'queued' | 'delivered'] =>
              entry[1] === 'queued' || entry[1] === 'delivered',
          )
          .map(([id, status]) => ({ id, status })),
      ),
    log: (line) => {
      logs.push(line);
    },
  };

  return {
    host,
    statuses,
    notes,
    logs,
    get attaches() {
      return attaches;
    },
    queueMessage: (message: BridgedMessage) => {
      statuses.set(message.id, 'queued');
      texts.set(message.id, message);

      drain();
    },
  };
}
