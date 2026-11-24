import { expect, test } from 'bun:test';
import { buildRPCLogPath, isRPCProcedurePath } from './build-rpc-log-path';

test.each([
  { path: '/rpc/session/spawn', logged: '/rpc/session/spawn' },
  { path: '/rpc/session/scope/add', logged: '/rpc/session/scope/add' },
  { path: '/rpc/session/spawn/extra', logged: '/rpc' },
  { path: '/rpc/unknown', logged: '/rpc' },
  { path: '/rpc', logged: '/rpc' },
  { path: '/mcp', logged: '/mcp' },
  { path: '/rpcs/session/spawn', logged: '/rpcs/session/spawn' },
])('it records $path as $logged', (row) => {
  expect(buildRPCLogPath(row.path)).toBe(row.logged);
});

test.each([
  { path: '/rpc/session/spawn', isProcedure: true },
  { path: '/rpc/session', isProcedure: false },
  { path: '/rpc', isProcedure: false },
])('it says whether $path is the path of one procedure', (row) => {
  expect(isRPCProcedurePath(row.path)).toBe(row.isProcedure);
});
