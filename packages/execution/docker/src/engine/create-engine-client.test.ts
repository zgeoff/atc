import { expect, onTestFinished, test } from 'bun:test';
import { join } from 'node:path';
import { createTempDir } from '@zgeoff/testing/fs';
import { createEngineClient } from './create-engine-client';

interface EngineReply {
  readonly status: number;
  readonly body: unknown;
}

function setupTest(replies: Record<string, EngineReply[]>) {
  const directory = createTempDir('atc-engine-');
  const socketPath = join(directory.path, 'engine.sock');
  const requests: string[] = [];

  const answerRequest = (request: Request): Response => {
    const key = `${request.method} ${new URL(request.url).pathname}`;

    requests.push(key);

    const queue = replies[key] ?? [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];

    return Response.json(reply?.body ?? { message: 'no reply' }, { status: reply?.status ?? 500 });
  };

  const server = Bun.serve({ unix: socketPath, fetch: answerRequest });

  onTestFinished(() => {
    void server.stop(true);
  });

  return { engine: createEngineClient(socketPath), requests };
}

test('it waits for a container that another removal is already taking away', async () => {
  const removing = {
    Name: '/atc-c1',
    Config: { Labels: {} },
    State: { Status: 'removing', ExitCode: 0 },
  };

  const ctx = setupTest({
    'DELETE /containers/atc-c1': [
      { status: 409, body: { message: 'removal of container atc-c1 is already in progress' } },
    ],
    'GET /containers/atc-c1/json': [
      { status: 200, body: removing },
      { status: 200, body: removing },
      { status: 404, body: { message: 'No such container: atc-c1' } },
    ],
  });

  await ctx.engine.removeContainer('atc-c1');

  expect(ctx.requests).toStrictEqual([
    'DELETE /containers/atc-c1',
    'GET /containers/atc-c1/json',
    'GET /containers/atc-c1/json',
    'GET /containers/atc-c1/json',
  ]);
});

test('it refuses a removal the Engine answers with another conflict', () => {
  const ctx = setupTest({
    'DELETE /containers/atc-c1': [{ status: 409, body: { message: 'container atc-c1 is locked' } }],
  });

  expect(ctx.engine.removeContainer('atc-c1')).rejects.toMatchObject({ status: 409 });
});

test('it refuses a conflict whose message is not a removal in progress, whatever its other fields say', () => {
  const ctx = setupTest({
    'DELETE /containers/atc-c1': [
      {
        status: 409,
        body: {
          message: 'container atc-c1 is locked',
          detail: 'removal of container atc-c1 is already in progress',
        },
      },
    ],
    'GET /containers/atc-c1/json': [
      { status: 404, body: { message: 'No such container: atc-c1' } },
    ],
  });

  expect(ctx.engine.removeContainer('atc-c1')).rejects.toMatchObject({ status: 409 });
});

test('it removes a volume once the Engine lets go of it after its last container', async () => {
  const ctx = setupTest({
    'DELETE /volumes/atc-v1': [
      { status: 409, body: { message: 'remove atc-v1: volume is in use - [4f2a9c]' } },
      { status: 200, body: {} },
    ],
  });

  await ctx.engine.removeVolume('atc-v1');

  expect(ctx.requests).toStrictEqual(['DELETE /volumes/atc-v1', 'DELETE /volumes/atc-v1']);
});
