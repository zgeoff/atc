import { expect, test } from 'bun:test';
import { buildLocalConfig } from './build-local-config.ts';

test('it points claude at the stand-in and the other agents at missing files', () => {
  expect(
    buildLocalConfig('/tmp/atc-test-home-pear/home', '/tmp/atc-test-home-pear/home/fake-claude'),
  ).toStrictEqual({
    agents: {
      claude: { kind: 'claude', bin: '/tmp/atc-test-home-pear/home/fake-claude' },
      grok: { kind: 'grok', bin: '/tmp/atc-test-home-pear/home/missing-grok' },
      codex: { kind: 'codex', bin: '/tmp/atc-test-home-pear/home/missing-codex' },
    },
    sources: { dirs: { roots: [] } },
  });
});
