import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCommand, setupTempDir } from '@atc/test-utils';

// A temp directory standing in for a repo root.
function setupTest() {
  const temporaryDirectory = setupTempDir('check-release-concurrency-');

  return { directory: temporaryDirectory.path };
}

test('it passes a release job that keeps a group per branch and never cancels', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-release-concurrency: 0 problems\n',
    stderr: '',
  });
});

test('it fails a release job that a newer run can cancel', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: true',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr:
      '.github/workflows/main.yml: job release can be cancelled; set cancel-in-progress: false\n',
  });
});

test('it fails a release job whose group every branch shares', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      '      group: main-release',
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr: `.github/workflows/main.yml: job release's group is shared by every branch; add \${{ github.ref }} to it\n`,
  });
});

test('it fails a workflow-level group that reaches the release job', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'concurrency:',
      `  group: main-\${{ github.ref }}`,
      '  cancel-in-progress: true',
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr:
      '.github/workflows/main.yml: a workflow-level concurrency group reaches the release job; set it per job\n',
  });
});

test('it fails a workflow with no release-please job', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    ['jobs:', '  ci:', '    steps:', '      - run: echo checks', ''].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr: '.github/workflows/main.yml: no job runs release-please\n',
  });
});

test('it fails a release-please job that corrects the latest mark itself', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 2 problems\n',
    stderr:
      '.github/workflows/main.yml: job release runs scripts/restore-latest-release.sh; run it in a job of its own\n' +
      '.github/workflows/main.yml: no job of its own runs scripts/restore-latest-release.sh\n',
  });
});

test('it fails a latest-mark job whose group each branch keeps apart', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      `      group: atc-latest-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr:
      '.github/workflows/main.yml: job latest-release needs one fixed group that every branch shares\n',
  });
});

test('it fails a latest-mark job that a newer run can cancel', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: true',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr:
      '.github/workflows/main.yml: job latest-release can be cancelled; set cancel-in-progress: false\n',
  });
});

test('it fails a latest-mark job that runs without waiting for the release', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [checks]',
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr: '.github/workflows/main.yml: job latest-release does not need the release-please job\n',
  });
});

test('it fails a latest-mark job that a failed release skips', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    outputs:',
      `      releases_created: \${{ steps.release.outputs.releases_created }}`,
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ needs.release.outputs.releases_created == 'true' }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr: `.github/workflows/main.yml: job latest-release runs on another condition than \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}\n`,
  });
});

test('it fails a release-please job that hands the latest-mark job no releases_created output', async () => {
  const ctx = setupTest();

  await Bun.write(
    join(ctx.directory, '.github/workflows/main.yml'),
    [
      'jobs:',
      '  release:',
      '    concurrency:',
      `      group: main-release-\${{ github.ref }}`,
      '      cancel-in-progress: false',
      '    steps:',
      '      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7',
      '  latest-release:',
      '    needs: [release]',
      `    if: \${{ !cancelled() && needs.release.result != 'skipped' && (needs.release.outputs.releases_created == 'true' || github.event_name == 'workflow_dispatch') }}`,
      '    concurrency:',
      '      group: atc-latest-release',
      '      cancel-in-progress: false',
      '    steps:',
      '      - run: scripts/restore-latest-release.sh "$GITHUB_REPOSITORY"',
      '',
    ].join('\n'),
  );

  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    ctx.directory,
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 1,
    stdout: 'check-release-concurrency: 1 problems\n',
    stderr: '.github/workflows/main.yml: job release sets no releases_created output\n',
  });
});

test("it passes the repo's own main workflow", async () => {
  const checked = await runCommand([
    process.execPath,
    join(import.meta.dir, 'check-release-concurrency.ts'),
    join(import.meta.dir, '..'),
  ]);

  expect({
    exitCode: checked.exitCode,
    stdout: checked.stdout,
    stderr: checked.stderr,
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'check-release-concurrency: 0 problems\n',
    stderr: '',
  });
});
