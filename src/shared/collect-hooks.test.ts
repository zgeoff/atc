import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { collectHooks } from './collect-hooks';

test('it collects hook entries keyed by wire-event name', () => {
  const hooks = collectHooks({
    SessionAttached: [{ command: 'notify-send attached' }],
    SessionRemoved: [
      { command: 'ork sync', dir: '/home/me/projects/ork', timeout: 5000 },
      { command: 'log-removal' },
    ],
  });

  expect(hooks).toStrictEqual({
    SessionAttached: [{ command: 'notify-send attached' }],
    SessionRemoved: [
      { command: 'ork sync', dir: '/home/me/projects/ork', timeout: 5000 },
      { command: 'log-removal' },
    ],
  });
});

test.each([[null], [undefined], [[]], ['garbage'], [42]])(
  'it collects no hooks when the value is %p',
  (raw) => {
    expect(collectHooks(raw)).toStrictEqual({});
  },
);

test('it skips entries without a command and drops an event name left with none', () => {
  const hooks = collectHooks({
    SessionAttached: [{ command: '' }, { dir: '/x' }, 'garbage', { command: 'keep-me' }],
    SessionState: [{ timeout: 100 }],
    SessionRemoved: 'not-an-array',
  });

  expect(hooks).toStrictEqual({ SessionAttached: [{ command: 'keep-me' }] });
});

test('it drops wrong-typed dir and timeout fields but keeps the entry', () => {
  const hooks = collectHooks({
    SessionAttached: [{ command: 'run-me', dir: 42, timeout: 'soon' }],
    SessionDetached: [{ command: 'run-me-too', timeout: -5 }],
  });

  expect(hooks).toStrictEqual({
    SessionAttached: [{ command: 'run-me' }],
    SessionDetached: [{ command: 'run-me-too' }],
  });
});

test('it expands a leading tilde and trims trailing slashes in dir', () => {
  const hooks = collectHooks({
    SessionAttached: [
      { command: 'a', dir: '~/projects/ork/' },
      { command: 'b', dir: '~' },
      { command: 'c', dir: '/opt/x//' },
    ],
  });

  expect(hooks).toStrictEqual({
    SessionAttached: [
      { command: 'a', dir: `${homedir()}/projects/ork` },
      { command: 'b', dir: homedir() },
      { command: 'c', dir: '/opt/x' },
    ],
  });
});

test('it keeps an event name the daemon does not emit', () => {
  const hooks = collectHooks({ SessionTeleported: [{ command: 'beam' }] });

  expect(hooks).toStrictEqual({ SessionTeleported: [{ command: 'beam' }] });
});
