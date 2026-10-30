import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $ } from 'bun';
import { createStubCurl } from './create-stub-curl';
import { setupTempDir } from './setup-temp-dir';

function setupTest() {
  const temporaryDirectory = setupTempDir('atc-stub-curl-');
  const downloads = join(temporaryDirectory.path, 'downloads');

  mkdirSync(downloads);

  return {
    directory: temporaryDirectory.path,
    downloads,
    curl: createStubCurl(join(temporaryDirectory.path, 'bin'), downloads),
  };
}

test('it writes the download named by the last segment of the URL', async () => {
  const ctx = setupTest();
  const out = join(ctx.directory, 'tool');

  writeFileSync(join(ctx.downloads, 'tool_v1_linux'), 'tool bytes');

  const result = await $`${ctx.curl} -fsSL -o ${out} https://example.test/releases/v1/tool_v1_linux`
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(out, 'utf8')).toBe('tool bytes');
});

test('it fails as a 404 does when the downloads folder holds no such file', async () => {
  const ctx = setupTest();

  const result =
    await $`${ctx.curl} -fsSL -o ${join(ctx.directory, 'tool')} https://example.test/missing`
      .nothrow()
      .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 22,
    stderr: 'curl: (22) The requested URL returned error: 404\n',
  });
});
