import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForFileContent } from './wait-for-file-content';

interface TestContext {
  readonly dir: string;
  [Symbol.asyncDispose]: () => Promise<void>;
}

function setupTest(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'atc-wait-file-'));

  return {
    dir,
    [Symbol.asyncDispose]: () => {
      rmSync(dir, { recursive: true, force: true });

      return Promise.resolve();
    },
  };
}

test('it returns the text of a file that already satisfies the default predicate', async () => {
  await using ctx = setupTest();

  const path = join(ctx.dir, 'ready');

  writeFileSync(path, 'already here\n');

  const text = await waitForFileContent(path);

  expect(text).toBe('already here\n');
});

test('it keeps polling until the predicate passes on later content', async () => {
  await using ctx = setupTest();

  const path = join(ctx.dir, 'growing');

  writeFileSync(path, 'partial');

  const pending = waitForFileContent(path, (text) => text.endsWith('done\n'));

  // A poll observing the not-yet-ready file leaves no signal; the settle
  // spans a few poll rounds so the wait proves polling, not a single read.
  await Bun.sleep(60);

  appendFileSync(path, ' then done\n');

  const text = await pending;

  expect(text).toBe('partial then done\n');
});

test('it throws naming the path when the deadline passes first', () => {
  const path = join(tmpdir(), 'atc-wait-file-never', 'never');

  expect(waitForFileContent(path, () => true, 100)).rejects.toThrowWithMessage(
    Error,
    `timed out waiting for file content at ${path}`,
  );
});
