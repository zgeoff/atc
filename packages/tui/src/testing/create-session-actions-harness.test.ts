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

  await harness.actions.sendForget('s-orchard');

  expect({ sent, notice: harness.overlay.notice }).toStrictEqual({
    sent: [['session.forget', { session: 's-orchard', refuseLive: true }]],
    notice: null,
  });
});
