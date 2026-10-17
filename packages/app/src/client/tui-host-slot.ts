import type { TUIHost } from './tui-host';

// the entry fills this before it loads the client, whose top-level code reads it once.
export const tuiHostSlot: { current: TUIHost | null } = { current: null };
