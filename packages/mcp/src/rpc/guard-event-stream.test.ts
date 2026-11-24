import { expect, test } from 'bun:test';
import { GRANT_SCOPES } from '@atcx/contract';
import type { GrantScope } from '@atcx/contract';
import { waitFor } from '@zgeoff/testing';
import { createFakeClock } from '@zgeoff/testing/clock';
import type { VerifiedAccess } from '../auth/types';
import { buildMockServiceAccess } from '../test-utils/build-mock-service-access';
import { guardEventStream } from './guard-event-stream';

function setupTest() {
  const clock = createFakeClock();
  const released: string[] = [];

  return {
    clock,
    released,
    guard: (
      source: AsyncIterator<unknown>,
      verify: (bearer: string) => Promise<VerifiedAccess | null>,
      signal?: AbortSignal,
    ) =>
      guardEventStream(source, {
        clock,
        verify,
        bearer: 'tok',
        principalID: 'service:ci',
        signal,
        release: () => {
          released.push('released');
        },
      }),
  };
}

test('it passes the items of the source through while the bearer verifies', async () => {
  const ctx = setupTest();
  const items = ['a', 'b'][Symbol.iterator]();

  const source: AsyncIterator<unknown> = {
    next: () => Promise.resolve(items.next()),
  };

  const stream = ctx.guard(source, () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)));

  const first = await stream.next();
  const second = await stream.next();
  const third = await stream.next();

  expect([first.value, second.value, third.done]).toStrictEqual(['a', 'b', true]);
});

test('it verifies the bearer again every 60 seconds and keeps the stream while it verifies', async () => {
  const ctx = setupTest();
  const verified: string[] = [];
  const pending = Promise.withResolvers<IteratorResult<unknown>>();
  const source: AsyncIterator<unknown> = { next: () => pending.promise };

  const stream = ctx.guard(source, (bearer) => {
    verified.push(bearer);

    return Promise.resolve(buildMockServiceAccess(GRANT_SCOPES));
  });

  const next = stream.next();

  await waitFor(() => ctx.clock.countPending() > 0);

  ctx.clock.advance(60_000);

  await waitFor(() => verified.length === 1);

  ctx.clock.advance(60_000);

  await waitFor(() => verified.length === 2);

  pending.resolve({ done: false, value: 'late' });

  const late = await next;

  expect([verified, late.value]).toStrictEqual([['tok', 'tok'], 'late']);
});

test.each<{ title: string; scopes: readonly GrantScope[]; name: string }>([
  { title: 'no longer holds read', scopes: ['message', 'spawn', 'kill'], name: 'ci' },
  { title: 'verifies as another principal', scopes: GRANT_SCOPES, name: 'other' },
])('it ends the stream, with nothing sent, when the bearer $title', async (row) => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<IteratorResult<unknown>>();
  const source: AsyncIterator<unknown> = { next: () => pending.promise };

  const stream = ctx.guard(source, () =>
    Promise.resolve(buildMockServiceAccess(row.scopes, row.name)),
  );

  const next = stream.next();

  await waitFor(() => ctx.clock.countPending() > 0);

  ctx.clock.advance(60_000);

  const ended = await next;

  pending.resolve({ done: false, value: 'after the failed check' });

  expect([ended, ctx.released]).toStrictEqual([{ done: true, value: undefined }, ['released']]);
});

test('it ends the stream when the check takes longer than 10 seconds', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<IteratorResult<unknown>>();
  const source: AsyncIterator<unknown> = { next: () => pending.promise };
  const stream = ctx.guard(source, () => new Promise<VerifiedAccess | null>(() => {}));
  const next = stream.next();

  await waitFor(() => ctx.clock.countPending() > 0);

  ctx.clock.advance(60_000);

  await waitFor(() => ctx.clock.countPending() > 0);

  ctx.clock.advance(9999);

  const early = ctx.released.length;

  ctx.clock.advance(1);

  const ended = await next;

  expect([early, ended.done, ctx.released]).toStrictEqual([0, true, ['released']]);
});

test('it ends the stream when the check throws', async () => {
  const ctx = setupTest();
  const pending = Promise.withResolvers<IteratorResult<unknown>>();
  const source: AsyncIterator<unknown> = { next: () => pending.promise };

  const stream = ctx.guard(source, () => {
    throw new Error('the auth database is closed');
  });

  const next = stream.next();

  await waitFor(() => ctx.clock.countPending() > 0);

  ctx.clock.advance(60_000);

  const ended = await next;

  expect(ended.done).toBe(true);
});

test('it reads no further item after a failed check when the client is slow to take the last one', async () => {
  const ctx = setupTest();
  let reads = 0;

  const source: AsyncIterator<unknown> = {
    next: () => {
      reads += 1;

      return Promise.resolve({ done: false, value: reads });
    },
  };

  const stream = ctx.guard(source, () => Promise.resolve(null));

  const first = await stream.next();

  ctx.clock.advance(60_000);

  await waitFor(() => ctx.released.length === 1);

  const ended = await stream.next();

  expect([first.value, ended.done, reads]).toStrictEqual([1, true, 1]);
});

test('it frees the place of a stream the request aborts before the stream starts', () => {
  const ctx = setupTest();

  const controller = new AbortController();

  const source: AsyncIterator<unknown> = { next: () => new Promise(() => {}) };

  ctx.guard(source, () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)), controller.signal);
  controller.abort();

  expect(ctx.released).toStrictEqual(['released']);
});

test('it frees the place of a stream whose request is already aborted', () => {
  const ctx = setupTest();
  const source: AsyncIterator<unknown> = { next: () => new Promise(() => {}) };

  ctx.guard(
    source,
    () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)),
    AbortSignal.abort(),
  );

  expect(ctx.released).toStrictEqual(['released']);
});

test('it frees the place and stops its timers when the stream returns before its first read', async () => {
  const ctx = setupTest();
  const source: AsyncIterator<unknown> = { next: () => new Promise(() => {}) };
  const stream = ctx.guard(source, () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)));

  await stream.return(undefined);

  expect([ctx.released, ctx.clock.countPending()]).toStrictEqual([['released'], 0]);
});

test('it frees the place once however the stream ends', async () => {
  const ctx = setupTest();

  const controller = new AbortController();

  const source: AsyncIterator<unknown> = { next: () => Promise.resolve({ done: false, value: 1 }) };

  const stream = ctx.guard(
    source,
    () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)),
    controller.signal,
  );

  await stream.next();
  await stream.return(undefined);

  controller.abort();

  expect(ctx.released).toStrictEqual(['released']);
});

test('it stops its timers when the stream ends', async () => {
  const ctx = setupTest();

  const source: AsyncIterator<unknown> = {
    next: () => Promise.resolve({ done: true, value: undefined }),
  };

  const stream = ctx.guard(source, () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)));

  await stream.next();

  expect(ctx.clock.countPending()).toBe(0);
});

test('it answers an error of the source as the program may read it', () => {
  const ctx = setupTest();

  const source: AsyncIterator<unknown> = {
    next: () =>
      Promise.reject(
        Object.assign(new Error('bad cursor'), { code: 'bad_args', data: { daemon: 'x' } }),
      ),
  };

  const stream = ctx.guard(source, () => Promise.resolve(buildMockServiceAccess(GRANT_SCOPES)));

  expect(stream.next()).rejects.toMatchObject({ code: 'bad_args', data: undefined });
});
