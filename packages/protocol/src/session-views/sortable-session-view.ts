import type { SessionViewState } from './session-state';

export interface SortableSessionView {
  readonly id: string;
  readonly parent: string | null;
  readonly state: SessionViewState;
  readonly pinned: boolean;
  readonly lastAttachedAt: number;
  readonly createdAt: number;
}
