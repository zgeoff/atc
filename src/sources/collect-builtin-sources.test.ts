import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '../../test/setup-temp-dir';
import { collectBuiltinSources } from './collect-builtin-sources';

test('it offers GitHub only when gh is on the host', () => {
  using temp = setupTempDir('atc-builtin-sources-');

  const gh = join(temp.dir, 'gh');

  const options = {
    roots: [],
    githubOwner: null,
    homeDir: temp.dir,
    collectZoxideDirs: () => Promise.resolve([]),
  };

  const withoutGH = collectBuiltinSources({ ...options, ghBin: gh });

  writeFileSync(gh, '#!/bin/sh\n', { mode: 0o755 });

  const withGH = collectBuiltinSources({ ...options, ghBin: gh });

  expect(withoutGH.map((source) => source.id)).toStrictEqual(['dirs', 'git']);
  expect(withGH.map((source) => source.id)).toStrictEqual(['dirs', 'github', 'git']);
});
