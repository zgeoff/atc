// SHA-1 repositories use 40 hex digits and SHA-256 ones 64; an abbreviated id
// never matches.
export const COMMIT_ID_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
