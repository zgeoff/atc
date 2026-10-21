import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { setupTempDir, startStubReporterSocket } from '@atc/test-utils';
import { sendReport } from './send-report';

// A temp directory to hold the reporter's socket.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-send-report-');

  return { path: join(temporaryDirectory.path, 'reporter.sock') };
}

test('it delivers a line larger than one socket write in full', async () => {
  const ctx = setupTest();
  const reporter = startStubReporterSocket(ctx.path);
  const text = 'x'.repeat(4 * 1024 * 1024);

  const isSent = await sendReport(ctx.path, `${text}\n`, 10_000);
  const line = await reporter.waitForLine();

  expect(isSent).toBeTrue();
  expect(line).toBe(text);
});

test('it resolves false when no socket listens', async () => {
  const ctx = setupTest();

  const isSent = await sendReport(ctx.path, 'lost\n', 2000);

  expect(isSent).toBeFalse();
});
