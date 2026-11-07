import { expect, mock, onTestFinished, test } from 'bun:test';
import { DaemonError } from '@atc/protocol/wire';
import { createActor } from 'xstate';
import { buildClientMachine } from './build-client-machine';
import { createFleetMirror } from './create-fleet-mirror';
import type { OverlayScreen } from './create-overlay-screen';
import { createSessionActions } from './create-session-actions';
import { buildStubClientScreens } from './testing/build-stub-client-screens';

type DaemonAnswer = Readonly<Record<string, unknown>>;

// The daemon's answer to each request's params; a throw refuses the request.
type AnswerRequest = (params?: DaemonAnswer) => DaemonAnswer;

function setupTest(answerRequest: AnswerRequest) {
  const service = createActor(buildClientMachine(buildStubClientScreens().deps));

  service.start();

  onTestFinished(() => {
    service.stop();
  });

  const overlay: Pick<OverlayScreen, 'notice' | 'render'> = {
    notice: null,
    render: () => {},
  };

  const daemon = {
    sendRequest: mock((_method: string, params?: DaemonAnswer) =>
      Promise.try(() => answerRequest(params)),
    ),
  };

  const actions = createSessionActions({
    service,
    mirror: createFleetMirror(),
    overlay,
    getClient: () => daemon,
    getMode: () => service.getSnapshot().value.mode,
    attach: mock(),
    sendQuiet: mock(),
    ptyRows: () => 24,
  });

  return { service, overlay, daemon, actions };
}

test('#sendForget shows the kept folder and its reasons when the forget keeps the workspace', async () => {
  const ctx = setupTest(() => ({
    forgotten: true,
    destroyed: false,
    workspace: {
      outcome: 'kept',
      path: '/srv/atc/workspaces/orchard-main-7',
      reasons: ['2 unpushed commits on fix-pears'],
    },
  }));

  await ctx.actions.sendForget('s-orchard');

  expect(ctx.overlay.notice).toBe('kept orchard-main-7: 2 unpushed commits on fix-pears');
});

test('#sendForget forgets only a session that is still exited', async () => {
  const ctx = setupTest(() => ({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'none' },
  }));

  await ctx.actions.sendForget('s-orchard');

  expect(ctx.daemon.sendRequest.mock.calls).toStrictEqual([
    ['session.forget', { session: 's-orchard', refuseLive: true }],
  ]);
});

test('#sendForget shows no notice when the forget removes the workspace', async () => {
  const ctx = setupTest(() => ({
    forgotten: true,
    destroyed: false,
    workspace: { outcome: 'removed', path: '/srv/atc/workspaces/orchard-main-8', found: [] },
  }));

  await ctx.actions.sendForget('s-orchard');

  expect(ctx.overlay.notice).toBeNull();
});

test("#sendForget shows the daemon's refusal of the forget", async () => {
  const ctx = setupTest(() => {
    throw new DaemonError(
      'session_live',
      'session s-orchard is live; stop it before forgetting it',
    );
  });

  await ctx.actions.sendForget('s-orchard');

  expect(ctx.overlay.notice).toBe('session s-orchard is live; stop it before forgetting it');
});

test('#sendForget asks to confirm a forget that destroys the host instead of showing a notice', async () => {
  const ctx = setupTest(() => ({ confirmToken: 'tok-pear', expiresAt: 1_900_000_000_000 }));

  await ctx.actions.sendForget('s-orchard');

  expect(ctx.service.getSnapshot().context.destroyID).toBe('s-orchard');
});

test('#sendDestroy hands the offered token back and shows a kept workspace', async () => {
  const ctx = setupTest((params) =>
    params?.['confirmToken'] === 'tok-pear'
      ? {
          forgotten: true,
          destroyed: false,
          workspace: {
            outcome: 'kept',
            path: '/home/guest/workspaces/orchard-main-9',
            reasons: ['1 stash'],
          },
        }
      : { confirmToken: 'tok-pear', expiresAt: 1_900_000_000_000 },
  );

  await ctx.actions.sendDestroy('s-orchard');

  expect(ctx.overlay.notice).toBe('kept orchard-main-9: 1 stash');
});

test("#sendDestroy shows the daemon's refusal of the confirmed forget", async () => {
  const ctx = setupTest((params) => {
    if (params?.['confirmToken'] === undefined) {
      return { confirmToken: 'tok-pear', expiresAt: 1_900_000_000_000 };
    }

    throw new DaemonError('internal', 'destroying host orchard failed');
  });

  await ctx.actions.sendDestroy('s-orchard');

  expect(ctx.overlay.notice).toBe('destroying host orchard failed');
});
