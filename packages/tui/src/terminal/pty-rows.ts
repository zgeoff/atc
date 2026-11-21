import { rows } from './rows';

// The rows the session gets: the window's, less the last row, which the fleet bar and the
// notices use.
export function ptyRows(): number {
  return Math.max(4, rows() - 1);
}
