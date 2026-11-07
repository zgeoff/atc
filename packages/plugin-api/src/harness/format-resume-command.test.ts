import { expect, test } from 'bun:test';
import { formatResumeCommand } from './format-resume-command';

test('it runs the command in the folder when there is no env file', () => {
  expect(formatResumeCommand('/srv/cart', 'codex resume c-1', null)).toBe(
    "cd '/srv/cart' && codex resume c-1",
  );
});

test('it has sh source the env file before it runs the command', () => {
  expect(formatResumeCommand('/srv/cart', 'grok --resume g-1', '/state/agent-env-grok.sh')).toBe(
    `cd '/srv/cart' && sh -c '. "$1" && shift && exec "$@"' sh '/state/agent-env-grok.sh' grok --resume g-1`,
  );
});
