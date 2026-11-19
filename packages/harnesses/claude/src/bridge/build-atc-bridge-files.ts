import { ATC_BRIDGE_FILES } from './atc-bridge-files';

export function buildATCBridgeFiles(
  argv: readonly string[],
  writtenAt?: number,
): Readonly<Record<string, string>> {
  return { ...ATC_BRIDGE_FILES, 'hooks/atc-cli.ts': renderATCCLIModule(argv, writtenAt) };
}

function renderATCCLIModule(argv: readonly string[], writtenAt: number | undefined): string {
  const module = `export const ATC_CLI: readonly string[] = ${JSON.stringify(argv)};\n`;

  return writtenAt === undefined
    ? module
    : `${module}// written again at ${String(writtenAt)}: Claude Code loads a mod again only when a file of it changes\n`;
}
