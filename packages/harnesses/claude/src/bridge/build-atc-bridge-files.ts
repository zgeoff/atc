import { ATC_BRIDGE_FILES } from './atc-bridge-files';

export function buildATCBridgeFiles(argv: readonly string[]): Readonly<Record<string, string>> {
  return { ...ATC_BRIDGE_FILES, 'hooks/atc-cli.ts': renderATCCLIModule(argv) };
}

function renderATCCLIModule(argv: readonly string[]): string {
  return `export const ATC_CLI: readonly string[] = ${JSON.stringify(argv)};\n`;
}
