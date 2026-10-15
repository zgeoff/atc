import { z } from 'zod';

/**
 * One item of a turn, as far as the bridge reads it: a `userMessage` with
 * the `clientId` its sender gave, or an `agentMessage` with its text.
 */
interface AppServerItem {
  readonly type: string;
  readonly clientId?: string;
  readonly text?: string;
}

/**
 * One turn of a thread: its id, its status (`inProgress`, `completed`,
 * `interrupted` or `failed`), and the items the server sent with it, which
 * a notification may leave out.
 */
export interface AppServerTurn {
  readonly id: string;
  readonly status: string;
  readonly items: readonly AppServerItem[];
}

const ITEM_SCHEMA = z.looseObject({
  type: z.string(),
  clientId: z.string().nullish(),
  text: z.string().optional(),
});

const TURN_SCHEMA = z.looseObject({
  id: z.string(),
  status: z.string(),
  items: z.array(z.unknown()).optional(),
});

/**
 * Parses a turn the App Server sent, or null when it holds no id or status.
 * An item the bridge cannot read is left out.
 */
export function parseAppServerTurn(value: unknown): AppServerTurn | null {
  const parsed = TURN_SCHEMA.safeParse(value);

  if (!parsed.success) {
    return null;
  }

  const items: AppServerItem[] = [];

  for (const raw of parsed.data.items ?? []) {
    const item = ITEM_SCHEMA.safeParse(raw);

    if (item.success) {
      items.push({
        type: item.data.type,
        ...(typeof item.data.clientId === 'string' ? { clientId: item.data.clientId } : {}),
        ...(item.data.text === undefined ? {} : { text: item.data.text }),
      });
    }
  }

  return { id: parsed.data.id, status: parsed.data.status, items };
}
