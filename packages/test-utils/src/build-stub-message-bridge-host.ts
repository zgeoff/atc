import type {
  BridgedMessage,
  BridgedNotice,
  MessageBridgeHost,
  MessageBridgeTap,
  UnsettledMessage,
} from '@atc/plugin-api';

type StubMessageStatus = 'queued' | 'delivered' | 'answered' | 'unanswered';

export function buildStubMessageBridgeHost(initial: readonly UnsettledMessage[] = []) {
  const statuses = new Map<string, StubMessageStatus>(initial.map((m) => [m.id, m.status]));
  const texts = new Map<string, BridgedMessage>();
  const notices = new Map<string, BridgedNotice>();
  const noticeStatuses = new Map<string, 'queued' | 'delivered'>();

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

    if (next !== undefined) {
      handed.add(next[0]);
      current.takeMessage(texts.get(next[0]) ?? { id: next[0], from: 'stub', text: '' });

      return;
    }

    const notice = [...noticeStatuses].find(
      ([id, status]) => status === 'queued' && !handed.has(`notice:${id}`),
    );

    if (notice !== undefined) {
      handed.add(`notice:${notice[0]}`);

      current.takeNotice(
        notices.get(notice[0]) ?? { id: notice[0], from: 'stub', status: 'answered' },
      );
    }
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
    ackNotice: (id) => {
      if (noticeStatuses.get(id) === 'queued') {
        noticeStatuses.set(id, 'delivered');
      }

      drain();

      return Promise.resolve();
    },
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

      drain();

      return Promise.resolve(true);
    },
    readUnsettledMessages: () =>
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
    noticeStatuses,
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
    queueNotice: (notice: BridgedNotice) => {
      noticeStatuses.set(notice.id, 'queued');
      notices.set(notice.id, notice);

      drain();
    },
  };
}
