import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The label that marks every image and volume the e2e suite creates, so a cleanup finds them
export const STAND_IN_LABEL = 'atc.e2e-docker';

const DOCKERFILE = `FROM debian:stable-slim
RUN useradd --create-home --shell /bin/bash agent
COPY claude /usr/local/bin/claude
LABEL ${STAND_IN_LABEL}=1
USER agent
WORKDIR /home/agent
`;

// Like the real CLI, it runs each hook command from the --settings file through a shell. The
// daemon holds a remote session's start report until a bridge attaches, which this stand-in has
// none of, so the start report runs in the background.
const STAND_IN_CLAUDE = `#!/bin/bash
settings=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--settings" ]; then settings="$arg"; fi
  prev="$arg"
done
echo "$*" >> "$HOME/starts.log"
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "$(cat /atc/sign-in/claude-oauth-token)" ]; then
  echo token-matches > "$HOME/token-seen"
fi
env | grep -c CLAUDE_CONFIG_DIR > "$HOME/config-dir-seen"
report() {
  cmd="$(EVENT="$1" perl -0777 -ne 'if (/"$ENV{EVENT}"\\s*:\\s*\\[.*?"command"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"/s) { $c = $1; $c =~ s/\\\\(.)/$1/g; print $c }' "$settings")"
  sh -c "$cmd"
}
printf '{"hook_event_name":"SessionStart","session_id":"stand-in-1","transcript_path":"%s/transcript.jsonl"}' "$HOME" | report SessionStart &
printf '{"hook_event_name":"Notification","session_id":"stand-in-1","message":"needs permission"}' | report Notification
while read -r line; do echo "GOT:$line"; done
`;

// Builds an image on a glibc base that holds a stand-in for the Claude CLI, and returns its tag.
export async function createStandInImage(directory: string, tag: string): Promise<string> {
  const context = join(directory, 'stand-in-image');

  mkdirSync(context, { recursive: true });
  writeFileSync(join(context, 'Dockerfile'), DOCKERFILE);
  writeFileSync(join(context, 'claude'), STAND_IN_CLAUDE);
  chmodSync(join(context, 'claude'), 0o755);

  const build = Bun.spawn(['docker', 'build', '--quiet', '--tag', tag, context], {
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);

  if (exitCode !== 0) {
    throw new Error(`docker build failed: ${stderr}`);
  }

  return tag;
}
