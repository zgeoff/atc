import { expect, onTestFinished, test } from 'bun:test';
import { createActor } from 'xstate';
import { buildStubClientScreens } from '../test-utils/build-stub-client-screens';
import { buildClientMachine } from './build-client-machine';

/**
 * A started client machine whose screens each record their name, and the
 * session or mode they were given, in `calls` in the order they open.
 * Disposal stops the machine.
 */
function setupTest() {
  const screens = buildStubClientScreens();
  const actor = createActor(buildClientMachine(screens.deps));

  actor.start();

  return {
    actor,
    calls: screens.calls,
    [Symbol.dispose]: () => {
      actor.stop();
    },
  };
}

test('it starts on the home screen and draws it', () => {
  const screens = buildStubClientScreens();
  const actor = createActor(buildClientMachine(screens.deps));

  onTestFinished(() => {
    actor.stop();
  });

  actor.start();

  expect(actor.getSnapshot().value).toBe('home');
  expect(screens.calls).toStrictEqual(['openHome']);
});

test('it opens the overlay from the home screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay']);
});

test('it attaches a session from the home screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'ATTACH', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it opens the spawn picker in resume mode from the home screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: true });

  expect(ctx.actor.getSnapshot().value).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:true']);
});

test('it opens the overlay from an attached session', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1', 'openOverlay']);
});

test('it repaints the overlay when the overlay is opened again', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openOverlay']);
});

test('it shows the help screen from the overlay', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HELP' });

  expect(ctx.actor.getSnapshot().value).toBe('help');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp']);
});

test('it opens the eject prompt for the selected session from the overlay', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value).toBe('picker-eject');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7']);
});

test('it returns to the overlay from the eject prompt', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openOverlay']);
});

test('it returns to the home screen from the spawn picker', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome']);
});

test('it attaches a session from the spawn picker', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's3' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openAttached:s3']);
});

test('it ignores the help key on the home screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'HELP' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
});

test('it ignores an eject request on the home screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
});

test('it ignores a return-home request while attached', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores a spawn request while attached', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'ATTACH', sessionID: 's1' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'SPAWN', resume: false });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores an eject request in the spawn picker', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false']);
});

test('it returns to the overlay from the help screen', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }, { type: 'HELP' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp', 'openOverlay']);
});

test('it attaches a session from the overlay', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's4' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openAttached:s4']);
});

test('it returns to the home screen from the overlay', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHome']);
});

test('it opens the spawn picker from the overlay', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'SPAWN', resume: true });

  expect(ctx.actor.getSnapshot().value).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openPicker:true']);
});

test('it attaches a session from the eject prompt', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'ATTACH', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openAttached:s7']);
});

test('it returns to the home screen from the eject prompt', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'OVERLAY' }, { type: 'EJECT', sessionID: 's7' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openHome']);
});

test('it opens the overlay from the spawn picker, as a finished daemon restart does', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'SPAWN', resume: false }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openOverlay']);
});

test('it redraws the home screen when a late spawn lands after the user is already home', () => {
  using ctx = setupTest();

  for (const event of [{ type: 'SPAWN', resume: false }, { type: 'HOME' }] as const) {
    ctx.actor.send(event);
  }

  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome', 'openHome']);
});
