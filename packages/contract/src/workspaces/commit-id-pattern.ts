// Git object ids are 40 hex digits in SHA-1 repositories and 64 in SHA-256 ones.
export const COMMIT_ID_PATTERN = /^(?:[\da-f]{40}|[\da-f]{64})$/u;
