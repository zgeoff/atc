import type { SessionState } from './session-state';

/**
 * The fields of a session row that the overlay orders by.
 */
export interface SortableSessionView {
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
}
