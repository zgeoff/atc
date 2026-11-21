import { expect, test } from 'bun:test';
import { waitFor } from '@zgeoff/testing';
import { createInMemoryEngine } from './create-in-memory-engine';

function setupTest() {
  const engine = createInMemoryEngine();

  return {
    engine,
    spec: {
      name: 'atc-s1',
      image: 'example/agents',
      labels: { 'atc.host': 'h1' },
      cmd: ['claude'],
      env: {},
      tty: true,
      stdin: 'held',
      mounts: [],
    } as const,
  };
}

test('it replays a container log from its first byte on each attach with logs', async () => {
  const ctx = setupTest();

  await ctx.engine.createContainer(ctx.spec);
  await ctx.engine.startContainer('atc-s1');

  ctx.engine.writeOutput('atc-s1', 'one');

  const attachment = await ctx.engine.attachContainer('atc-s1', { stdin: true, logs: true });

  const received: string[] = [];

  attachment.onData((data) => {
    received.push(new TextDecoder().decode(data));
  });

  await waitFor(() => {
    expect(received).toStrictEqual(['one']);
  });

  ctx.engine.writeOutput('atc-s1', 'two');

  expect(received).toStrictEqual(['one', 'two']);
});

test('it lists the containers whose labels match', async () => {
  const ctx = setupTest();

  await ctx.engine.createContainer(ctx.spec);
  await ctx.engine.createContainer({ ...ctx.spec, name: 'other', labels: { 'atc.host': 'h2' } });

  const listed = await ctx.engine.listContainers({ 'atc.host': 'h1' });

  const names = listed.map((container) => container.name);

  expect(names).toStrictEqual(['atc-s1']);
});

test('it stops each container that ran or was paused when the Engine restarts', async () => {
  const ctx = setupTest();

  await ctx.engine.createContainer(ctx.spec);
  await ctx.engine.startContainer('atc-s1');
  await ctx.engine.pauseContainer('atc-s1');

  ctx.engine.restart();

  const read = await ctx.engine.readContainer('atc-s1');

  expect(read).toStrictEqual({
    name: 'atc-s1',
    labels: { 'atc.host': 'h1' },
    status: 'exited',
    exitCode: 137,
  });
});

test('it runs a command to completion when it starts and reports what it printed', async () => {
  const ctx = setupTest();

  ctx.engine.answerRuns(() => ({ stdout: 'out', stderr: 'err', exitCode: 3 }));

  await ctx.engine.createContainer({ ...ctx.spec, tty: false, stdin: 'none' });

  const attachment = await ctx.engine.attachContainer('atc-s1', { stdin: false, logs: false });

  const received: string[] = [];

  const ended = new Promise<void>((resolve) => {
    attachment.onEnd(resolve);
  });

  attachment.onData((data, stream) => {
    received.push(`${stream}:${new TextDecoder().decode(data)}`);
  });

  await ctx.engine.startContainer('atc-s1');

  await ended;

  expect(received).toStrictEqual(['stdout:out', 'stderr:err']);

  const read = await ctx.engine.readContainer('atc-s1');

  expect(read?.exitCode).toBe(3);
});

test('it refuses a call while the Engine is unreachable', () => {
  const ctx = setupTest();

  ctx.engine.setUnreachable(true);

  expect(() => ctx.engine.readInfo()).toThrow('does not answer');
});
