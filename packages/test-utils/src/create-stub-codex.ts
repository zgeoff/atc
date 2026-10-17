import { createStubBin } from './create-stub-bin';

interface StubCodexConfig {
  // The command atc runs as; the stub reports each hook through its
  // `hook-report --agent codex`, as the hook entries atc prints for Codex do.
  readonly atc: readonly string[];

  // The composer script the stub finishes in.
  readonly composer: string;
}

export function createStubCodex(dir: string, config: StubCodexConfig): string {
  const report = `${config.atc.map((part) => `"${part}"`).join(' ')} hook-report --agent codex`;

  return createStubBin(
    dir,
    'fake-codex',
    `#!/usr/bin/env bash
echo "FAKE_CODEX_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"%s/fake-rollout.jsonl","cwd":"%s","source":"startup"}' "$HOME" "$PWD" | ${report}
printf '{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"%s/fake-rollout.jsonl","last_assistant_message":"pong"}' "$HOME" | ${report}
exec "${process.execPath}" "${config.composer}"
`,
  );
}
