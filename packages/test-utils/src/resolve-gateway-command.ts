import { getSourceEntry } from './get-source-entry';

export function resolveGatewayCommand(binary: string | undefined): readonly string[] {
  return binary === undefined ? [process.execPath, getSourceEntry('atc-gateway')] : [binary];
}
