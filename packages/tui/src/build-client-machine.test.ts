import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { buildClientMachine } from './build-client-machine';
import { buildStubClientScreens } from './testing/build-stub-client-screens';

function setupTest() {
  const screens = buildStubClientScreens();
  const actor = createActor(buildClientMachine(screens.deps));

  onTestFinished(() => {
    actor.stop();
  });

  return { actor, calls: screens.calls };
}

test('it starts on the home screen and draws it', () => {
  const ctx = setupTest();

  ctx.actor.start();

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
});

test('it opens the overlay from the home screen', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay']);
});

test('it attaches a session from the home screen', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'ATTACH', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it opens the spawn picker in resume mode from the home screen', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'SPAWN', resume: true });

  expect(ctx.actor.getSnapshot().value.mode).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:true']);
});

test('it lets the attached session go before it opens the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1', 'closeAttached', 'openOverlay']);
});

test('it lets the attached session go before it attaches another from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }, { type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's2' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');

  expect(ctx.calls).toStrictEqual([
    'openHome',
    'openAttached:s1',
    'closeAttached',
    'openOverlay',
    'openAttached:s2',
  ]);
});

test('it repaints the overlay when the overlay is opened again', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openOverlay']);
});

test('it shows the help screen from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HELP' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('help');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp']);
});

test('it opens the eject prompt for the selected session from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('picker-eject');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7']);
});

test('it returns to the overlay from the eject prompt', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openOverlay']);
});

test('it returns to the home screen from the spawn picker', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome']);
});

test('it attaches a session from the spawn picker', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's3' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openAttached:s3']);
});

test('it ignores the help key on the home screen', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'HELP' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
});

test('it ignores an eject request on the home screen', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
});

test('it ignores a return-home request while attached', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores a spawn request while attached', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'SPAWN', resume: false });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores an eject request in the spawn picker', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false']);
});

test('it returns to the overlay from the help screen', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }, { type: 'HELP' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp', 'openOverlay']);
});

test('it attaches a session from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's4' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openAttached:s4']);
});

test('it returns to the home screen from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHome']);
});

test('it opens the spawn picker from the overlay', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'SPAWN', resume: true });

  expect(ctx.actor.getSnapshot().value.mode).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openPicker:true']);
});

test('it attaches a session from the eject prompt', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openAttached:s7']);
});

test('it returns to the home screen from the eject prompt', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openHome']);
});

test('it opens the overlay from the spawn picker, as a finished daemon restart does', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openOverlay']);
});

test('it redraws the home screen when a late spawn lands after the user is already home', () => {
  const ctx = setupTest();

  ctx.actor.start();

  for (const event of [{ type: 'SPAWN', resume: false }, { type: 'HOME' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome', 'openHome']);
});

test('it starts with no confirmation, no restart prompt, and the daemon connected', () => {
  const ctx = setupTest();

  ctx.actor.start();

  expect(ctx.actor.getSnapshot().value).toStrictEqual({
    mode: 'home',
    confirm: 'none',
    consent: 'none',
    daemon: 'connected',
  });

  expect(ctx.actor.getSnapshot().context).toStrictEqual({
    destroyID: null,
    consent: null,
    freshUntil: 0,
  });
});

test('it waits on a kill confirmation until the next key settles it', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'CONFIRM_KILL' });

  const pending = ctx.actor.getSnapshot().value.confirm;

  ctx.actor.send({ type: 'CONFIRM_DONE' });

  expect(pending).toBe('kill');
  expect(ctx.actor.getSnapshot().value.confirm).toBe('none');
});

test('it holds the session whose forget waits on a confirmation and drops it once settled', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'CONFIRM_DESTROY', sessionID: 's-harbor' });

  const pending = ctx.actor.getSnapshot();

  ctx.actor.send({ type: 'CONFIRM_DONE' });

  expect(pending.value.confirm).toBe('destroy');
  expect(pending.context.destroyID).toBe('s-harbor');
  expect(ctx.actor.getSnapshot().context.destroyID).toBeNull();
});

test('it drops a pending confirmation when the overlay opens again', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'CONFIRM_DESTROY', sessionID: 's-harbor' });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value.confirm).toBe('none');
  expect(ctx.actor.getSnapshot().context.destroyID).toBeNull();
});

test('it keeps the screen mode while a confirmation waits', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'CONFIRM_KILL' });

  expect(ctx.actor.getSnapshot().value.mode).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay']);
});

test('it holds the restart prompt until its key arrives', () => {
  const ctx = setupTest();
  const consent = { prompt: 'Restart it now? [y/N] ', answer: () => {} };

  ctx.actor.start();
  ctx.actor.send({ type: 'CONSENT_ASKED', consent });

  const asking = ctx.actor.getSnapshot();

  ctx.actor.send({ type: 'CONSENT_ANSWERED' });

  expect(asking.value.consent).toBe('asking');
  expect(asking.context.consent).toBe(consent);
  expect(ctx.actor.getSnapshot().value.consent).toBe('none');
  expect(ctx.actor.getSnapshot().context.consent).toBeNull();
});

test('it waits for the daemon once the connection is lost and is connected once it is ready', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'DAEMON_LOST' });

  const waiting = ctx.actor.getSnapshot().value.daemon;

  ctx.actor.send({ type: 'DAEMON_READY' });

  expect(waiting).toBe('waiting');
  expect(ctx.actor.getSnapshot().value.daemon).toBe('connected');
});

test('it stays restarting through a loss and a reconnect and holds the time the old daemon is refused until', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'RESTART_STARTED' });
  ctx.actor.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: 9000 });
  ctx.actor.send({ type: 'DAEMON_LOST' });
  ctx.actor.send({ type: 'DAEMON_READY' });

  expect(ctx.actor.getSnapshot().value.daemon).toBe('restarting');
  expect(ctx.actor.getSnapshot().context.freshUntil).toBe(9000);
});

test.each([
  ['connected', true],
  ['waiting', false],
] as const)('it ends a restart %s and clears its refusal time', (expected, connected) => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'RESTART_STARTED' });
  ctx.actor.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: 9000 });
  ctx.actor.send({ type: 'RESTART_ENDED', connected });

  expect(ctx.actor.getSnapshot().value.daemon).toBe(expected);
  expect(ctx.actor.getSnapshot().context.freshUntil).toBe(0);
});

test('it connects a restart that ended waiting once its late daemon is ready', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'RESTART_STARTED' });
  ctx.actor.send({ type: 'RESTART_AWAITING_FRESH', freshUntil: 9000 });
  ctx.actor.send({ type: 'RESTART_ENDED', connected: false });
  ctx.actor.send({ type: 'DAEMON_READY' });
  ctx.actor.send({ type: 'RESTART_ENDED', connected: true });

  expect(ctx.actor.getSnapshot().value.daemon).toBe('connected');
});

test('it starts a restart while it waits for a lost daemon', () => {
  const ctx = setupTest();

  ctx.actor.start();
  ctx.actor.send({ type: 'DAEMON_LOST' });
  ctx.actor.send({ type: 'RESTART_STARTED' });

  expect(ctx.actor.getSnapshot().value.daemon).toBe('restarting');
});
