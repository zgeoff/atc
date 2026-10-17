import { AppServerError } from './app-server-error';

// Whether a request failed because the server answered it with an error,
// as opposed to a connection that closed before an answer came.
export function isRefusal(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code !== -1;
}
