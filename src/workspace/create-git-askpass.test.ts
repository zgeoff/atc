import { expect, onTestFinished, spyOn, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises'; // oxlint-disable-line no-namespace -- only the module namespace lets a spy fail the helper's write on demand
import { setupTempDir } from '../../test/setup-temp-dir';
import { updateEnv } from '../../test/update-env';
import { createGitAskpass } from './create-git-askpass';

test('it removes the helper directory when the helper cannot be written', async () => {
  await using temp = setupTempDir('atc-askpass-test-');

  updateEnv('TMPDIR', temp.dir);
  updateEnv('ATC_TEST_ASKPASS_TOKEN', 'tok-askpass');

  const write = spyOn(fsPromises, 'writeFile').mockRejectedValueOnce(
    new Error('ENOSPC: no space left on device'),
  );

  onTestFinished(() => {
    write.mockRestore();
  });

  const created = createGitAskpass({ kind: 'env', name: 'ATC_TEST_ASKPASS_TOKEN' });

  expect(created).rejects.toThrow('ENOSPC');

  await created.catch(() => null);

  expect(readdirSync(temp.dir)).toStrictEqual([]);
});
