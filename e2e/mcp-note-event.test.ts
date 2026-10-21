import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '@atc/core';
import { setupMCPHome } from '@atc/lifecycle/testing';
import { startMCPStdio, waitFor } from '@atc/test-utils';
import invariant from 'tiny-invariant';

// The stand-in Claude sends its note through the real `atc note` command, so
// this case runs `atc mcp` and the daemon it boots as processes.
async function setupTest() {
  const mcpHome = setupMCPHome();

  const mcp = await startMCPStdio({ home: mcpHome.home });

  return { home: mcpHome.home, mcp };
}

test('it returns the whole text of a note its event previews, and the preview on request', async () => {
  const ctx = await setupTest();

  const whole = `${'option '.repeat(150)}end`;

  writeFileSync(join(ctx.home, 'fake-claude-note'), whole);

  await ctx.mcp.spawnSession({ cwd: ctx.home });

  const full = await waitFor(async () => {
    const read = await ctx.mcp.sendToolCall('atc_events_read', {});

    const listed = read.structured?.['events'];

    expect(listed).toPartiallyContain({ kind: 'note' });

    return listed;
  });

  const preview = await ctx.mcp.sendToolCall('atc_events_read', { previewOnly: true });

  invariant(Array.isArray(full), 'the events read holds no events');

  const fullNote: unknown = full.find(
    (candidate: unknown) => isRecord(candidate) && candidate['kind'] === 'note',
  );

  invariant(isRecord(fullNote), 'the events read holds no note event');

  expect(fullNote).toStrictEqual({
    cursor: expect.toBeString(),
    at: expect.toBeNumber(),
    session: expect.toBeString(),
    name: expect.toBeString(),
    kind: 'note',
    label: 'decision',
    detail: `${'option '.repeat(150).slice(0, 599)}…`,
    text: whole,
    complete: true,
  });

  expect(preview.structured?.['events']).toContainEqual({
    cursor: fullNote['cursor'],
    at: fullNote['at'],
    session: fullNote['session'],
    name: fullNote['name'],
    kind: 'note',
    label: 'decision',
    detail: `${'option '.repeat(150).slice(0, 599)}…`,
  });
});
