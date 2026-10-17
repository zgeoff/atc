import { createStubBin } from './create-stub-bin';

interface StubGrokConfig {
  // The command atc runs as; the stub reports each hook through its
  // `hook-report --agent grok`, as the hook file atc prints for Grok does.
  readonly atc: readonly string[];

  // The composer script the stub finishes in.
  readonly composer: string;
}

export function createStubGrok(dir: string, config: StubGrokConfig): string {
  const report = `${config.atc.map((part) => `"${part}"`).join(' ')} hook-report --agent grok`;

  return createStubBin(
    dir,
    'fake-grok',
    `#!/usr/bin/env bash
echo "FAKE_GROK_UP args: $@"
if [ -f "$HOME/fake-grok-hold-start" ]; then while read -r line; do echo "GOT:$line"; done; exit 0; fi
printf '{"hookEventName":"session_start","sessionId":"fake-grok-1","cwd":"%s"}' "$PWD" | ${report}
if [ -f "$HOME/fake-grok-events.jsonl" ]; then
  while IFS= read -r ev; do
    [ -n "$ev" ] || continue
    printf '%s' "$ev" | ${report}
  done < "$HOME/fake-grok-events.jsonl"
else
  printf '{"hookEventName":"notification","sessionId":"fake-grok-1","notificationType":"permission_prompt","message":"allow edit?"}' | ${report}
fi
echo "FAKE_GROK_HOOKS_DONE"
exec "${process.execPath}" "${config.composer}"
`,
  );
}
