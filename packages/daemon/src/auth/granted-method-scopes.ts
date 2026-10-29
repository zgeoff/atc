import type { GrantScope } from '@atcx/contract';

// The requests the atc MCP tools send, less the ones that read the daemon
// host's files or the whole fleet; a method the table leaves out is refused
// whatever a session's atc access holds.
export const GRANTED_METHOD_SCOPES: Readonly<Record<string, GrantScope | 'any'>> = {
  'daemon.hello': 'any',
  'daemon.ping': 'any',

  // The daemon's client subscribes after its handshake, and the connection's
  // view delivers events only while the session holds read.
  'events.subscribe': 'any',

  'session.list': 'read',
  'session.get': 'read',
  'session.read': 'read',
  'session.screen': 'read',
  'session.menu': 'read',
  'events.read': 'read',
  'message.get': 'read',
  'note.get': 'read',
  'answer.get': 'read',
  'agents.list': 'read',

  'session.message': 'message',
  'session.update': 'message',
  'session.ack': 'message',

  'session.spawn': 'spawn',
  'session.submit': 'spawn',
  'session.choose': 'spawn',
  'session.scope.add': 'spawn',
  'session.adopt': 'spawn',

  'session.kill': 'kill',
  'session.forget': 'kill',
};
