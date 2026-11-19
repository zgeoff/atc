import { AppServerError } from './app-server-error';

// Codex App Server answers with this JSON-RPC code when its queue is full.
// The request was not taken; retrying later may succeed.
const OVERLOADED_CODE = -32_001;

export function isOverload(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code === OVERLOADED_CODE;
}
