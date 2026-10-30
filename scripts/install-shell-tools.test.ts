import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubCurl, setupTempDir } from '@atc/test-utils';
import { $ } from 'bun';

// A downloads folder that the stand-in curl serves from, a runner temp
// folder, and the file that GitHub reads the added PATH entries from.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-install-shell-tools-');
  const downloads = join(temporaryDirectory.path, 'downloads');
  const runnerTemp = join(temporaryDirectory.path, 'runner-temp');
  const bin = join(temporaryDirectory.path, 'bin');

  mkdirSync(downloads);
  mkdirSync(runnerTemp);
  createStubCurl(bin, downloads);

  return {
    directory: temporaryDirectory.path,
    downloads,
    runnerTemp,
    githubPath: join(temporaryDirectory.path, 'github-path'),
    path: `${bin}:${process.env['PATH'] ?? ''}`,
  };
}

// The installer runs on CI's Linux runner, and checks each hash with
// sha256sum, which macOS lacks.
test.skipIf(process.platform !== 'linux')(
  'it installs both tools and adds their folder to the PATH of later steps',
  async () => {
    const ctx = setupTest();
    const release = join(ctx.directory, 'shellcheck-v8.0.0');

    writeFileSync(join(ctx.downloads, 'shfmt_v9.0.0_linux_amd64'), 'shfmt bytes');
    mkdirSync(release);
    writeFileSync(join(release, 'shellcheck'), 'shellcheck bytes');

    await $`tar -czf ${join(ctx.downloads, 'shellcheck-v8.0.0.linux.x86_64.tar.gz')} -C ${ctx.directory} shellcheck-v8.0.0`.quiet();

    const archive = readFileSync(join(ctx.downloads, 'shellcheck-v8.0.0.linux.x86_64.tar.gz'));

    const result = await $`bash ${join(import.meta.dir, 'install-shell-tools.sh')}`
      .env({
        ...process.env,
        PATH: ctx.path,
        RUNNER_TEMP: ctx.runnerTemp,
        GITHUB_PATH: ctx.githubPath,
        SHFMT_VERSION: 'v9.0.0',
        SHFMT_SHA256: new Bun.CryptoHasher('sha256').update('shfmt bytes').digest('hex'),
        SHELLCHECK_VERSION: 'v8.0.0',
        SHELLCHECK_SHA256: new Bun.CryptoHasher('sha256').update(archive).digest('hex'),
      })
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(ctx.runnerTemp, 'shell-tools', 'shfmt'), 'utf8')).toBe('shfmt bytes');

    expect(readFileSync(join(ctx.runnerTemp, 'shell-tools', 'shellcheck'), 'utf8')).toBe(
      'shellcheck bytes',
    );

    expect(readFileSync(ctx.githubPath, 'utf8')).toBe(`${join(ctx.runnerTemp, 'shell-tools')}\n`);
  },
);

test.skipIf(process.platform !== 'linux')(
  'it fails and adds nothing to the PATH when a download differs from its hash',
  async () => {
    const ctx = setupTest();

    writeFileSync(join(ctx.downloads, 'shfmt_v9.0.0_linux_amd64'), 'tampered bytes');

    const result = await $`bash ${join(import.meta.dir, 'install-shell-tools.sh')}`
      .env({
        ...process.env,
        PATH: ctx.path,
        RUNNER_TEMP: ctx.runnerTemp,
        GITHUB_PATH: ctx.githubPath,
        SHFMT_VERSION: 'v9.0.0',
        SHFMT_SHA256: new Bun.CryptoHasher('sha256').update('shfmt bytes').digest('hex'),
        SHELLCHECK_VERSION: 'v8.0.0',
        SHELLCHECK_SHA256: '0',
      })
      .nothrow()
      .quiet();

    expect(result.exitCode).toBe(1);
    expect(existsSync(ctx.githubPath)).toBeFalse();
  },
);
