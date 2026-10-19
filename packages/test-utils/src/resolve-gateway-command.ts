import { readSourceEntry } from './read-source-entry';

export function resolveGatewayCommand(binary: string | undefined): readonly string[] {
  return binary === undefined ? [process.execPath, readSourceEntry('atc-gateway')] : [binary];
}
