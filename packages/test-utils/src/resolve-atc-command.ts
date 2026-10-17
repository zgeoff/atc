import { getSourceEntry } from './get-source-entry';

export function resolveATCCommand(): string[] {
  // Read at each call, so a test that sets the variable sees its own value.
  const bin = process.env['ATC_BIN'];

  return bin === undefined ? [process.execPath, getSourceEntry('atc')] : [bin];
}
