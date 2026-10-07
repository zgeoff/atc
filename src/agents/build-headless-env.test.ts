import { expect, test } from 'bun:test';
import { toSessionID } from '../shared/to-session-id';
import { updateEnv } from '../test-utils/update-env';
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
  updateEnv('CLAUDE_CODE_PLUGIN_DIRS', '/parent/plugins');

  const env = buildHeadlessEnv({ socketPath: '/state/r.sock' });

  expect(env['CLAUDE_CODE_PLUGIN_DIRS']).toBeUndefined();
});

test('it leaves the variables a run withholds out of its environment', () => {
  updateEnv('ATC_TEST_WORKSPACE_CRED', 'fixture-not-a-secret');

  const env = buildHeadlessEnv({
    sessionID: toSessionID('s-1'),
    socketPath: '/state/r.sock',
    withheldEnv: ['ATC_TEST_WORKSPACE_CRED'],
  });

  expect(env).not.toContainKey('ATC_TEST_WORKSPACE_CRED');
  expect(env['ATC_SESSION_ID']).toBe('s-1');
});
