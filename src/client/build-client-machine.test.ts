import { expect, test } from 'bun:test';
import { createActor } from 'xstate';
import type { ClientMachineDeps } from './build-client-machine';
import { buildClientMachine } from './build-client-machine';

function setupActor() {
  const calls: string[] = [];

  const deps: ClientMachineDeps = {
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
  };

  const actor = createActor(buildClientMachine(deps));

  actor.start();

  return { actor, calls };
}

test('it starts on the home screen and draws it', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome']);
});

test('it opens the overlay from the home screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openOverlay']);
});

test('it attaches a session from the home screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'ATTACH', sessionID: 's1' });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it opens the spawn picker in resume mode from the home screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: true });

  expect(actor.getSnapshot().value).toBe('picker');
  expect(calls).toStrictEqual(['openHome', 'openPicker:true']);
});

test('it opens the overlay from an attached session', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'ATTACH', sessionID: 's1' });
  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openAttached:s1', 'openOverlay']);
});

test('it repaints the overlay when the overlay is opened again', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openOverlay']);
});

test('it shows the help screen from the overlay', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'HELP' });

  expect(actor.getSnapshot().value).toBe('help');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp']);
});

test('it opens the eject prompt for the selected session from the overlay', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'EJECT', sessionID: 's7' });

  expect(actor.getSnapshot().value).toBe('picker-eject');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7']);
});

test('it returns to the overlay from the eject prompt', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'EJECT', sessionID: 's7' });
  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openOverlay']);
});

test('it returns to the home screen from the spawn picker', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: false });
  actor.send({ type: 'HOME' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome']);
});

test('it attaches a session from the spawn picker', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: false });
  actor.send({ type: 'ATTACH', sessionID: 's3' });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openPicker:false', 'openAttached:s3']);
});

test('it ignores the help key on the home screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'HELP' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome']);
});

test('it ignores an eject request on the home screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome']);
});

test('it ignores a return-home request while attached', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'ATTACH', sessionID: 's1' });
  actor.send({ type: 'HOME' });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores a spawn request while attached', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'ATTACH', sessionID: 's1' });
  actor.send({ type: 'SPAWN', resume: false });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openAttached:s1']);
});

test('it ignores an eject request in the spawn picker', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: false });
  actor.send({ type: 'EJECT', sessionID: 's1' });

  expect(actor.getSnapshot().value).toBe('picker');
  expect(calls).toStrictEqual(['openHome', 'openPicker:false']);
});

test('it returns to the overlay from the help screen', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'HELP' });
  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openHelp', 'openOverlay']);
});

test('it attaches a session from the overlay', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'ATTACH', sessionID: 's4' });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openAttached:s4']);
});

test('it returns to the home screen from the overlay', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'HOME' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openHome']);
});

test('it opens the spawn picker from the overlay', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'SPAWN', resume: true });

  expect(actor.getSnapshot().value).toBe('picker');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openPicker:true']);
});

test('it attaches a session from the eject prompt', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'EJECT', sessionID: 's7' });
  actor.send({ type: 'ATTACH', sessionID: 's7' });

  expect(actor.getSnapshot().value).toBe('attached');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openAttached:s7']);
});

test('it returns to the home screen from the eject prompt', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'OVERLAY' });
  actor.send({ type: 'EJECT', sessionID: 's7' });
  actor.send({ type: 'HOME' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome', 'openOverlay', 'openEject:s7', 'openHome']);
});

test('it opens the overlay from the spawn picker, as a finished daemon restart does', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: false });
  actor.send({ type: 'OVERLAY' });

  expect(actor.getSnapshot().value).toBe('overlay');
  expect(calls).toStrictEqual(['openHome', 'openPicker:false', 'openOverlay']);
});

test('it redraws the home screen when a late spawn lands after the user is already home', () => {
  const run = setupActor();
  const actor = run.actor;
  const calls = run.calls;

  actor.send({ type: 'SPAWN', resume: false });
  actor.send({ type: 'HOME' });
  actor.send({ type: 'HOME' });

  expect(actor.getSnapshot().value).toBe('home');
  expect(calls).toStrictEqual(['openHome', 'openPicker:false', 'openHome', 'openHome']);
});
