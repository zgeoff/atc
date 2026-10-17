import { AppServerError } from './app-server-error';

// The JSON-RPC error code a Codex App Server answers with when its queue
// is full: the request was not taken, and the same request may succeed
// later.
const OVERLOADED_CODE = -32_001;

// Whether the server turned a request away because its queue was full.
export function isOverload(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code === OVERLOADED_CODE;
}
