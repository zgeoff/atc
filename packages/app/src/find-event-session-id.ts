import type { DaemonEvent } from '@atcx/contract';
import { P, match } from 'ts-pattern';

export function findEventSessionID(event: DaemonEvent): string | null {
  return match(event)
    .with({ ev: P.union('PermissionResolved', 'DaemonRestarted') }, () => null)
    .with(
      { ev: P.union('SessionAdded', 'SessionState', 'SessionAttached', 'SessionDetached') },
      (sessionEvent) => sessionEvent.session.id,
    )
    .with(
      {
        ev: P.union(
          'SessionRenamed',
          'SessionRemoved',
          'SessionResized',
          'SessionOutput',
          'SessionDesync',
          'PermissionRequested',
          'SessionMessage',
          'SessionNote',
          'InboxMessage',
          'InboxNotice',
          'InboxClosed',
        ),
      },
      (sessionEvent) => sessionEvent.sessionID,
    )
    .exhaustive();
}
