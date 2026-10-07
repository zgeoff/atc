import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import { buildClientMachine } from './build-client-machine';

/**
 * A started client machine whose side effects each append their name, and
 * the session or mode they were given, to `calls` in the order they run.
 * Disposal stops the machine.
 */
function setupTest() {
  const calls: string[] = [];

  const actor = createActor(
    buildClientMachine({
      openHome: () => {
        calls.push('openHome');
      },
      openAttached: (sessionID) => {
        calls.push(`openAttached:${sessionID}`);
      },
      openOverlay: () => {
        calls.push('openOverlay');
      },
      openHelp: () => {
        calls.push('openHelp');
      },
      openPicker: (resume) => {
        calls.push(`openPicker:${resume}`);
      },
      openEject: (sessionID) => {
        calls.push(`openEject:${sessionID}`);
      },
    }),
  );

  actor.start();

  return {
    actor,
    calls,
    [Symbol.dispose]: () => {
      actor.stop();
    },
  };
}

test('it starts on the home screen and draws it', () => {
  using ctx = setupTest();

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome']);
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

  ctx.actor.send({ type: 'ATTACH', sessionID: 's1' });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1', 'openOverlay']);
});

test('it repaints the overlay when the overlay is opened again', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openOverlay']);
});

test('it shows the help screen from the overlay', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'HELP' });

  expect(ctx.actor.getSnapshot().value).toBe('help');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp']);
});

test('it opens the eject prompt for the selected session from the overlay', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value).toBe('picker-eject');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7']);
});

test('it returns to the overlay from the eject prompt', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openOverlay']);
});

test('it returns to the home screen from the spawn picker', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: false });
  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome']);
});

test('it attaches a session from the spawn picker', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: false });
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

  ctx.actor.send({ type: 'ATTACH', sessionID: 's1' });
  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores a spawn request while attached', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'ATTACH', sessionID: 's1' });
  ctx.actor.send({ type: 'SPAWN', resume: false });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores an eject request in the spawn picker', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: false });
  ctx.actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(ctx.actor.getSnapshot().value).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false']);
});

test('it returns to the overlay from the help screen', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'HELP' });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp', 'openOverlay']);
});

test('it attaches a session from the overlay', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'ATTACH', sessionID: 's4' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openAttached:s4']);
});

test('it returns to the home screen from the overlay', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openHome']);
});

test('it opens the spawn picker from the overlay', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'SPAWN', resume: true });

  expect(ctx.actor.getSnapshot().value).toBe('picker');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openPicker:true']);
});

test('it attaches a session from the eject prompt', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });
  ctx.actor.send({ type: 'ATTACH', sessionID: 's7' });

  expect(ctx.actor.getSnapshot().value).toBe('attached');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openAttached:s7']);
});

test('it returns to the home screen from the eject prompt', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'OVERLAY' });
  ctx.actor.send({ type: 'EJECT', sessionID: 's7' });
  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openHome']);
});

test('it opens the overlay from the spawn picker, as a finished daemon restart does', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: false });
  ctx.actor.send({ type: 'OVERLAY' });

  expect(ctx.actor.getSnapshot().value).toBe('overlay');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openOverlay']);
});

test('it redraws the home screen when a late spawn lands after the user is already home', () => {
  using ctx = setupTest();

  ctx.actor.send({ type: 'SPAWN', resume: false });
  ctx.actor.send({ type: 'HOME' });
  ctx.actor.send({ type: 'HOME' });

  expect(ctx.actor.getSnapshot().value).toBe('home');
  expect(ctx.calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome', 'openHome']);
});
