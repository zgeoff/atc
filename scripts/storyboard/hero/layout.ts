export interface Spot {
  readonly x: number;
  readonly y: number;
}

export const NAMED_SIZE = 15;
export const BACKGROUND_SIZE = 13.5;

// the islands: the gateway in the middle, the hosts round it
export const GATEWAY = { x: 500, y: 296, width: 90 };
export const LAPTOP = { x: 172, y: 330, width: 104 };
export const IMPZ = { x: 842, y: 346, width: 92 };
export const SPRITES = { x: 362, y: 492, width: 92 };

// the named agents, standing on their islands
export const ORCHESTRATOR: Spot = { x: LAPTOP.x, y: LAPTOP.y };
export const BUILDER_API: Spot = { x: IMPZ.x + 6, y: IMPZ.y + 2 };
export const BUILDER_UI: Spot = { x: SPRITES.x + 14, y: SPRITES.y + 6 };

// the tower's foot and the beacon above it
export const TOWER_FOOT = GATEWAY.y + 10;
export const BEACON: Spot = { x: GATEWAY.x, y: TOWER_FOOT - 94 };

// the inbox panel floating above the tower
export const INBOX = { x: GATEWAY.x - 130 + 14, y: 26, width: 260, height: 110, rowHeight: 22 };
export const INBOX_FIRST_ROW_Y = INBOX.y + 46;
export const INBOX_FOOT: Spot = { x: GATEWAY.x, y: INBOX.y + INBOX.height };

// where an agent's lid is, for a message that leaves or reaches it
export function getTopOf(spot: Spot, size = NAMED_SIZE): Spot {
  return { x: spot.x, y: spot.y - size * 1.15 - 2 };
}

export const BUILDER_UI_TOP: Spot = { x: BUILDER_UI.x, y: BUILDER_UI.y - NAMED_SIZE * 1.2 };
