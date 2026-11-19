import { AppServerError } from './app-server-error';

export function isRefusal(error: unknown): error is AppServerError {
  return error instanceof AppServerError && error.code !== -1;
}
