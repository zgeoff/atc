import type { SessionKey } from './session-key';

// A map that takes a SessionKey, so no caller encodes one.
export interface SessionMap<T> {
  readonly get: (key: SessionKey) => T | undefined;
  readonly set: (key: SessionKey, value: T) => void;
  readonly remove: (key: SessionKey) => void;
}

export function createSessionMap<T>(): SessionMap<T> {
  const entries = new Map<string, T>();

  return {
    get: (key) => entries.get(encodeKey(key)),
    set: (key, value) => {
      entries.set(encodeKey(key), value);
    },
    remove: (key) => {
      entries.delete(encodeKey(key));
    },
  };
}

// A JSON pair keeps a null daemon apart from a daemon named like an id.
function encodeKey(key: SessionKey): string {
  return JSON.stringify([key.daemon, key.id]);
}
