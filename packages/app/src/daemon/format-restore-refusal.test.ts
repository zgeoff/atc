import { expect, test } from 'bun:test';
import { toSessionID } from '@atc/core/to-session-id';
import { DaemonError } from '@atc/protocol/daemon-error';
import { formatRestoreRefusal } from './format-restore-refusal';

test('it adds the rebind and adopt commands to a refusal for a changed auth selection', () => {
  expect(
    formatRestoreRefusal(
      toSessionID('s-cloud'),
      new DaemonError('auth_rebind_required', 'the auth profiles changed', {
        host: 's-cloud',
        revision: 1,
        problem: 'auth_selection_changed',
      }),
    ),
  ).toBe(
    'the auth profiles changed. Fix: atc session rebind s-cloud (MCP: atc_session_auth_rebind), then atc session adopt s-cloud (MCP: atc_session_adopt)',
  );
});

test.each(['revoked', 'rebind_failed'])(
  'it adds the rebind and adopt commands to a refusal for a host blocked as %s',
  (state) => {
    expect(
      formatRestoreRefusal(
        toSessionID('s-cloud'),
        new DaemonError('auth_blocked', 'the runtime auth is blocked', { host: 's-cloud', state }),
      ),
    ).toBe(
      'the runtime auth is blocked. Fix: atc session rebind s-cloud (MCP: atc_session_auth_rebind), then atc session adopt s-cloud (MCP: atc_session_adopt)',
    );
  },
);

test('it adds the adopt command to a refusal for a dropped auth block', () => {
  expect(
    formatRestoreRefusal(
      toSessionID('s-cloud'),
      new DaemonError('auth_rebind_required', 'the agent dropped its auth', {
        agent: 'glm',
        state: 'ready',
        problem: 'auth_dropped',
      }),
    ),
  ).toBe(
    'the agent dropped its auth. Once the auth block is back: atc session adopt s-cloud (MCP: atc_session_adopt)',
  );
});

test('it adds the adopt command to a refusal for a launch a rebind overtook', () => {
  expect(
    formatRestoreRefusal(
      toSessionID('s-cloud'),
      new DaemonError('auth_rebind_required', 'the revision moved', {
        host: 's-cloud',
        revision: 3,
        problem: 'revision_moved',
      }),
    ),
  ).toBe('the revision moved. Try again: atc session adopt s-cloud (MCP: atc_session_adopt)');
});

test('it keeps the message alone for a host blocked while a revoke is pending', () => {
  expect(
    formatRestoreRefusal(
      toSessionID('s-cloud'),
      new DaemonError('auth_blocked', 'the runtime auth is blocked', {
        host: 's-cloud',
        state: 'revocation_pending',
      }),
    ),
  ).toBe('the runtime auth is blocked');
});

test('it keeps the message alone for a refusal no rebind clears', () => {
  expect(
    formatRestoreRefusal(
      toSessionID('s-cloud'),
      new DaemonError('target_unavailable', "target 'box' is not available"),
    ),
  ).toBe("target 'box' is not available");
});
