import type { GrantScope } from '../sessions/grant-scope';

// The scope of the MCP tool that calls each procedure.
export const FLEET_PROCEDURE_SCOPES = {
  'daemons.list': 'read',
  'agents.list': 'read',
  'dirs.list': 'read',
  'session.list': 'read',
  'session.get': 'read',
  'session.read': 'read',
  'session.screen': 'read',
  'message.get': 'read',
  'note.get': 'read',
  'answer.get': 'read',
  'events.read': 'read',
  'session.message': 'message',
  'session.update': 'message',
  'session.ack': 'message',
  'session.spawn': 'spawn',
  'session.submit': 'spawn',
  'session.menu': 'spawn',
  'session.choose': 'spawn',
  'session.adopt': 'spawn',
  'session.scope.add': 'spawn',
  'session.auth.rebind': 'spawn',
  'session.kill': 'kill',
  'session.forget': 'kill',
} as const satisfies Readonly<Record<string, GrantScope>>;

export type FleetProcedureName = keyof typeof FLEET_PROCEDURE_SCOPES;
