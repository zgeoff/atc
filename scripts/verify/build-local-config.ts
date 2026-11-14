import { join } from 'node:path';

// The config of the `local` target's daemon. Claude runs the stand-in, and Grok and Codex point at
// files that do not exist, so the daemon lists them as not installed and starts no real agent. The
// one source lists folders, so the picker never runs the host's `gh`.
export function buildLocalConfig(home: string, stub: string): Readonly<Record<string, unknown>> {
  return {
    agents: {
      claude: { kind: 'claude', bin: stub },
      grok: { kind: 'grok', bin: join(home, 'missing-grok') },
      codex: { kind: 'codex', bin: join(home, 'missing-codex') },
    },
    sources: { dirs: { roots: [] } },
  };
}
