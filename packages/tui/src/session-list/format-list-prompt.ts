import type { OverlaySessionView } from './types';

export type ListPromptKind = 'kill' | 'end' | 'destroy';

// The question on the panel's last line. `destroy` is the second question of an end that the
// first question did not word as deleting a machine.
export function formatListPrompt(
  kind: ListPromptKind,
  session: Readonly<OverlaySessionView>,
  endedSubSessions: number,
): string {
  if (kind === 'kill') {
    return `kill ${session.name}? · y / n`;
  }

  const isDeleting = kind === 'destroy' || session.canDestroyHost === true;

  const effect = isDeleting
    ? `stops the agent and deletes its ${session.place.label} machine, with every session on it`
    : 'stops the agent and removes it from the list';

  return `end ${session.name}? ${effect}${formatSubSessions(endedSubSessions)} · y / n`;
}

function formatSubSessions(count: number): string {
  if (count === 0) {
    return '';
  }

  return `, and removes its ${count} ended ${count === 1 ? 'sub-session' : 'sub-sessions'}`;
}
