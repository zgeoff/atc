export type SessionState = 'running' | 'needs_you' | 'done' | 'exited';

// What a client shows for a state it does not know, such as one a newer daemon adds.
export type SessionViewState = SessionState | 'unknown';
