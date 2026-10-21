import type { UnsettledMessage } from '@atc/plugin-api';
import { z } from 'zod';
import type { AppServerConnection } from './create-app-server-connection';
import { parseAppServerTurn } from './parse-app-server-turn';
import type { AppServerTurn } from './parse-app-server-turn';

const TURNS_PAGE_SCHEMA = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

// Pages back through the thread's turns until every unsettled message
// has its turn or the history ends. A failed page rejects the whole read.
export async function readThreadTurns(
  conn: AppServerConnection,
  thread: string | null,
  unsettled: readonly UnsettledMessage[],
): Promise<AppServerTurn[]> {
  const open = new Set(unsettled.map((message) => message.id));

  const turns: AppServerTurn[] = [];
  let cursor: string | null = null;

  do {
    const result = await conn.sendRequest('thread/turns/list', {
      threadId: thread,
      limit: 20,
      itemsView: 'full',
      cursor,
    });

    const page = TURNS_PAGE_SCHEMA.parse(result);

    for (const raw of page.data) {
      const turn = parseAppServerTurn(raw);

      if (turn !== null) {
        turns.push(turn);

        for (const item of turn.items) {
          open.delete(item.clientId ?? '');
        }
      }
    }

    cursor = page.nextCursor ?? null;
  } while (cursor !== null && open.size > 0);

  return turns;
}
