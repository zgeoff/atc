import { isRecord } from '@atc/core';

export function buildTrustedClaudeConfig(
  config: Readonly<Record<string, unknown>>,
  folders: readonly string[],
): Record<string, unknown> {
  const projects = isRecord(config['projects']) ? config['projects'] : {};

  const trusted = Object.fromEntries(
    folders.map((folder) => {
      const entry = projects[folder];

      return [folder, { ...(isRecord(entry) ? entry : {}), hasTrustDialogAccepted: true }];
    }),
  );

  return { ...config, projects: { ...projects, ...trusted } };
}
