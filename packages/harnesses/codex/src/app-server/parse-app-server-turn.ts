import { z } from 'zod';

interface AppServerItem {
  readonly type: string;
  readonly clientId?: string;
  readonly text?: string;
}

export interface AppServerTurn {
  readonly id: string;

  // `inProgress`, `completed`, `interrupted` or `failed`
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
