import { expect, onTestFinished, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { buildHeadlessEnv } from './build-headless-env';

test('it loads the mod and names the session and socket for a session run', () => {
  const env = buildHeadlessEnv({
    pluginDir: '/state/atc-bridge',
    sessionID: toSessionID('s-1'),
    socketPath: '/state/reporter.sock',
  });

  expect(env).toMatchObject({
    CLAUDE_CODE_PLUGIN_DIRS: '/state/atc-bridge',
    ATC_SESSION_ID: 's-1',
    ATC_SOCKET: '/state/reporter.sock',
  });
});

test('it keeps the mod folder when the run carries no session', () => {
  const env = buildHeadlessEnv({ pluginDir: '/state/atc-bridge', socketPath: '/state/r.sock' });

  expect(env['CLAUDE_CODE_PLUGIN_DIRS']).toBe('/state/atc-bridge');
});

test('it drops an enclosing session mod folder when none is supplied', () => {
  const prior = process.env['CLAUDE_CODE_PLUGIN_DIRS'];

  process.env['CLAUDE_CODE_PLUGIN_DIRS'] = '/parent/plugins';

  onTestFinished(() => {
    if (prior === undefined) {
      delete process.env['CLAUDE_CODE_PLUGIN_DIRS'];
    } else {
      process.env['CLAUDE_CODE_PLUGIN_DIRS'] = prior;
    }
  });

  const env = buildHeadlessEnv({ socketPath: '/state/r.sock' });

  expect(env['CLAUDE_CODE_PLUGIN_DIRS']).toBeUndefined();
});
