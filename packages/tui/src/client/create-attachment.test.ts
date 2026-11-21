import { expect, onTestFinished, test } from 'bun:test';
import type { DaemonClient } from '@atc/protocol/client';
import { createActor } from 'xstate';
import { buildMockMirrorSession } from '../test-utils/build-mock-mirror-session';
import { buildStubClientScreens } from '../test-utils/build-stub-client-screens';
import { buildClientMachine } from './build-client-machine';
import { createAttachment } from './create-attachment';

interface TestOptions {
  readonly isLinkUp: boolean;
  readonly hasFocused: boolean;
}

function setupTest(options: TestOptions) {
  const screens = buildStubClientScreens();
  const service = createActor(buildClientMachine(screens.deps));
  const asked: string[] = [];
  const stream: string[] = [];
  const notices: string[] = [];

  onTestFinished(() => {
    service.stop();
  });

  service.start();

  const client = {
    sendRequest: (method: string, params?: Readonly<Record<string, unknown>>) => {
      asked.push(`${method}:${String(params?.['session'])}`);

      return Promise.resolve({ cols: 80, rows: 24 });
    },

    // the real connection throws until the hello is accepted
    get connection(): DaemonClient['connection'] {
      throw new Error('no hello yet');
    },
  };

  const attachment = createAttachment({
    links: {
      clientFor: () => (options.isLinkUp ? client : null),
      stateOf: () => ({ kind: 'down', detail: 'the connection dropped' }),
    },
    stream: {
      begin: (key) => {
        stream.push(`begin:${key.id}`);
      },
      end: () => {
        stream.push('end');
      },
      resize: () => {},
    },
    readService: () => service,
    findFocused: () => (options.hasFocused ? buildMockMirrorSession({ id: 'one' }) : null),
    readSize: () => ({ cols: 80, rows: 24 }),
    sendQuiet: (_daemon, method, params) => {
      asked.push(`${method}:${String(params?.['session'])}`);

      return Promise.resolve();
    },
    showStatusNotice: (text) => {
      notices.push(text);
    },
    reportFailure: () => {},
  });

  return { attachment, asked, stream, notices, calls: screens.calls };
}

test('#attach begins the stream and asks the daemon to attach a session that is not attached', async () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: true });

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  expect({ stream: ctx.stream, asked: ctx.asked }).toStrictEqual({
    stream: ['end', 'begin:one'],
    asked: ['session.attach:one'],
  });
});

test('#attach asks the daemon to attach the session behind the list again, and keeps its stream', async () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: true });

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  ctx.stream.length = 0;
  ctx.asked.length = 0;

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  expect({ stream: ctx.stream, asked: ctx.asked }).toStrictEqual({
    stream: [],
    asked: ['session.attach:one'],
  });
});

test('#attach lets the daemon go of the attached session before it attaches another', async () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: true });

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  ctx.asked.length = 0;

  await ctx.attachment.attach({ daemon: null, id: 'two' });

  expect(ctx.asked).toStrictEqual(['session.detach:one', 'session.attach:two']);
});

test('#attach says why it attached nothing when the daemon link is down', async () => {
  const ctx = setupTest({ isLinkUp: false, hasFocused: true });

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  expect({ notices: ctx.notices, asked: ctx.asked }).toStrictEqual({
    notices: ['local: down — the connection dropped'],
    asked: [],
  });
});

test('#showBase closes the list on home when no session is behind it', () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: false });

  ctx.attachment.showBase();

  expect(ctx.calls).toStrictEqual(['openHome', 'openHome']);
});

test('#showBase attaches the focused session again when the TUI holds no attachment to it', () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: true });

  ctx.attachment.showBase();

  expect({ calls: ctx.calls, asked: ctx.asked }).toStrictEqual({
    calls: ['openHome', 'openAttached:one'],
    asked: ['session.attach:one'],
  });
});

test('#detach lets the daemon go of the attached session and ends the stream', async () => {
  const ctx = setupTest({ isLinkUp: true, hasFocused: true });

  await ctx.attachment.attach({ daemon: null, id: 'one' });

  ctx.asked.length = 0;
  ctx.stream.length = 0;

  ctx.attachment.detach();

  expect({
    asked: ctx.asked,
    stream: ctx.stream,
    key: ctx.attachment.readAttachedKey(),
  }).toStrictEqual({ asked: ['session.detach:one'], stream: ['end'], key: null });
});
