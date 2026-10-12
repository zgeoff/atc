import { expect, test } from 'bun:test';
import { SHIPPED_EXECUTION_PLUGINS } from './shipped-execution-plugins';

test('it ships the local PTY and imp execution plugins', () => {
  expect(SHIPPED_EXECUTION_PLUGINS.map((plugin) => plugin.id)).toStrictEqual(['local-pty', 'imp']);
});
