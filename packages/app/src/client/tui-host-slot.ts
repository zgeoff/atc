import type { TUIHost } from './tui-host';

/**
 * The host the TUI runs against. The entry fills it before it loads the
 * client, whose top-level code reads it once.
 */
export const tuiHostSlot: { current: TUIHost | null } = { current: null };
