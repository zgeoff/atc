import { expect, test } from 'bun:test';
import { PROCEDURE_TRAITS } from './procedure-traits';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';

test('it holds a procedure for every request method, plus the subscription', () => {
  expect([...PROCEDURE_TRAITS.keys()]).toIncludeSameMembers([
    ...Object.keys(REQUEST_PARAM_SCHEMAS),
    'events.subscribe',
  ]);
});

test('it keeps the daemon-wide and credential methods, and only those, owner-only', () => {
  const owned = [...PROCEDURE_TRAITS]
    .filter(([, traits]) => traits.access === 'owner')
    .map(([method]) => method);

  expect(owned).toIncludeSameMembers([
    'daemon.quit',
    'daemon.backup',
    'daemon.restarted',
    'fleet.restore',
    'session.auth.revoke',
    'session.auth.rebind',
  ]);
});

test('it marks only the procedures that change nothing as read-only', () => {
  const readOnly = [...PROCEDURE_TRAITS]
    .filter(([, traits]) => traits.readOnly)
    .map(([method]) => method);

  expect(readOnly).toIncludeSameMembers([
    'daemon.hello',
    'daemon.ping',
    'dirs.list',
    'agents.list',
    'sources.list',
    'sources.interpret',
    'sources.complete',
    'git.probe',
    'fleet.list',
    'session.list',
    'session.resumeCommand',
    'session.screen',
    'session.menu',
    'session.get',
    'session.read',
    'events.read',
    'events.subscribe',
    'message.get',
    'note.get',
    'answer.get',
  ]);
});

test('it marks the spawn and the message, and only those, as keyed', () => {
  const keyed = [...PROCEDURE_TRAITS]
    .filter(([, traits]) => traits.keyed)
    .map(([method]) => method);

  expect(keyed).toIncludeSameMembers(['session.spawn', 'session.message']);
});
