import { expect, onTestFinished, test } from 'bun:test';
import { createSessionActionsHarness } from './create-session-actions-harness';

test('it sends the actions through the client it was given and starts with no notice', async () => {
  const sent: unknown[] = [];

  const harness = createSessionActionsHarness({
    sendRequest: (method, params) => {
      sent.push([method, params]);

      return Promise.resolve({ forgotten: true, destroyed: false, workspace: { outcome: 'none' } });
    },
  });

  onTestFinished(harness.stop);

  await harness.actions.sendEnd({ daemon: null, id: 's-orchard' }, false);

  expect({ sent, notice: harness.overlay.notice }).toStrictEqual({
    sent: [['session.forget', { session: 's-orchard', refusePinned: true }]],
    notice: null,
  });
});

test('it collects the home notices of a session it was told is attached', async () => {
  const harness = createSessionActionsHarness({
    sendRequest: () =>
      Promise.resolve({
        forgotten: true,
        destroyed: false,
        workspace: { outcome: 'kept', path: '/work/orchard', reasons: ['a stash'] },
      }),
  });

  onTestFinished(harness.stop);

  harness.focus({ daemon: null, id: 's-orchard' });

  await harness.actions.sendEnd({ daemon: null, id: 's-orchard' }, false);

  expect(harness.homeNotices).toStrictEqual(['kept orchard: a stash']);
});
