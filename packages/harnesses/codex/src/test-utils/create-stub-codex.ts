import { writeStubProgram } from '@atc/core/test-utils/write-stub-program';

interface StubCodexConfig {
  readonly atc: readonly string[];

  readonly composer: string;
}

export function createStubCodex(directory: string, config: StubCodexConfig): string {
  const report = `${config.atc.map((part) => `"${part}"`).join(' ')} hook-report --agent codex`;

  return writeStubProgram(
    directory,
    'fake-codex',
    `#!/usr/bin/env bash
echo "FAKE_CODEX_UP args: $@"
printf '{"hook_event_name":"SessionStart","session_id":"fake-codex-1","transcript_path":"%s/fake-rollout.jsonl","cwd":"%s","source":"startup"}' "$HOME" "$PWD" | ${report}
printf '{"hook_event_name":"Stop","session_id":"fake-codex-1","transcript_path":"%s/fake-rollout.jsonl","last_assistant_message":"pong"}' "$HOME" | ${report}
exec "${process.execPath}" "${config.composer}"
`,
  );
}
