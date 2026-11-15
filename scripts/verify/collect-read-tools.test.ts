import { expect, test } from 'bun:test';
import { collectReadTools } from './collect-read-tools.ts';

test('it lists the tools that take the read scope, and no tool that writes', () => {
  const tools = collectReadTools();

  expect(tools).toIncludeAllMembers([
    'atc_sessions_list',
    'atc_session_get',
    'atc_terminal_read',
    'atc_message_get',
  ]);

  expect(tools).not.toIncludeAnyMembers([
    'atc_session_spawn',
    'atc_terminal_type',
    'atc_message_send',
    'atc_session_stop',
  ]);
});
