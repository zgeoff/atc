import type { RequestMethod } from '../protocol/parse-request-params';

/**
 * Who may make a request: `owner` is the daemon's owner alone, and
 * `principal` is also open to a principal, which runs it through the
 * context scoped to that principal.
 */
export type RequestAccessClass = 'owner' | 'principal';

/**
 * The access class of every request method, checked when a request is
 * admitted and before it runs. The type takes every method the protocol
 * defines, so a method without a class fails typecheck. Owner-class
 * methods act on the whole daemon, or on the credentials a session's host
 * may use.
 */
export const REQUEST_ACCESS_CLASSES: Readonly<Record<RequestMethod, RequestAccessClass>> = {
  'daemon.hello': 'principal',
  'daemon.ping': 'principal',
  'daemon.quit': 'owner',
  'session.list': 'principal',
  'dirs.list': 'principal',
  'agents.list': 'principal',
  'sources.list': 'principal',
  'sources.interpret': 'principal',
  'git.probe': 'principal',
  'fleet.list': 'principal',
  'fleet.restore': 'owner',
  'session.spawn': 'principal',
  'session.kill': 'principal',
  'session.ack': 'principal',
  'session.forget': 'principal',
  'session.resumeCommand': 'principal',
  'session.auth.revoke': 'owner',
  'session.auth.rebind': 'owner',
  'session.update': 'principal',
  'session.attach': 'principal',
  'session.detach': 'principal',
  'session.input': 'principal',
  'session.submit': 'principal',
  'session.resize': 'principal',
  'session.screen': 'principal',
  'session.eject': 'principal',
  'session.adopt': 'principal',
  'permission.respond': 'principal',
  'session.get': 'principal',
  'session.read': 'principal',
  'events.read': 'principal',
  'session.message': 'principal',
  'session.tap': 'principal',
  'message.get': 'principal',
  'report.get': 'principal',
  'message.ack': 'principal',
};
