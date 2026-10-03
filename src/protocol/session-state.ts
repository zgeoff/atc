/**
 * Where a session stands for the person watching it: busy, waiting on them,
 * finished with a turn, or ended.
 */
export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';
