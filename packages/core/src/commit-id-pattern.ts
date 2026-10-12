/**
 * A full git commit id: 40 lowercase hex digits for a SHA-1 repository, 64
 * for a SHA-256 one. An abbreviated id never matches.
 */
export const COMMIT_ID_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
