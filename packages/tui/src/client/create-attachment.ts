import type { DaemonClient } from '@atc/protocol/client';
import { formatLinkState } from '../daemon-link/daemon-link-state';
import type { DaemonLinkState } from '../daemon-link/daemon-link-state';
import { pickReplay } from '../daemon-link/pick-replay';
import { sendToDaemon } from '../daemon-link/send-to-daemon';
import { isSameSessionKey } from '../fleet/session-key';
import type { DaemonName, SessionKey } from '../fleet/session-key';
import type { MirrorSession } from '../fleet/to-mirror-session';
import type { SessionStream } from '../screen/create-session-stream';
import type { ClientActor } from './build-client-machine';

export interface AttachmentDeps {
  readonly links: {
    readonly clientFor: (
      daemon: DaemonName,
    ) => Pick<DaemonClient, 'sendRequest' | 'connection'> | null;
    readonly stateOf: (daemon: DaemonName) => DaemonLinkState;
  };
  readonly stream: Pick<SessionStream, 'begin' | 'end' | 'resize'>;
  readonly readService: () => ClientActor;
  readonly findFocused: () => MirrorSession | null;
  readonly readSize: () => { readonly cols: number; readonly rows: number };
  readonly sendQuiet: (
    daemon: DaemonName,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly showStatusNotice: (text: string) => void;
  readonly reportFailure: (daemon: DaemonName, error: unknown) => void;
}

export interface Attachment {
  // the session the TUI holds an attachment to on its daemon, or null
  readonly readAttachedKey: () => SessionKey | null;

  // Shows a session. A session that is already attached, such as the one behind the session list,
  // stays attached, and the daemon hears the attach again. Any other attached session is let go first.
  readonly attach: (key: SessionKey) => Promise<void>;

  // attaches again after the daemon connection came back
  readonly reattach: (key: SessionKey) => void;

  // closes the list on the session behind it, or on home when none is
  readonly showBase: () => void;

  // lets the daemon size the session to the other clients, which a client that no longer shows
  // the session does not hold back
  readonly detach: () => void;
}

export function createAttachment(deps: AttachmentDeps): Attachment {
  let attachedKey: SessionKey | null = null;

  const isAttachedTo = (key: SessionKey): boolean =>
    attachedKey !== null && isSameSessionKey(attachedKey, key);

  const request = async (key: SessionKey) => {
    const replay = pickReplay(deps.links, key.daemon);
    const size = { cols: deps.readSize().cols, rows: deps.readSize().rows };

    deps.stream.begin(key, replay, size);

    attachedKey = key;

    const answer = await sendToDaemon(deps.links, key.daemon, 'session.attach', {
      session: key.id,
      ...size,
      ...(replay === 'full' ? { replay } : {}),
    });

    if (typeof answer['cols'] === 'number' && typeof answer['rows'] === 'number') {
      deps.stream.resize(answer['cols'], answer['rows']);
    }
  };

  const detach = () => {
    if (attachedKey !== null) {
      void deps.sendQuiet(attachedKey.daemon, 'session.detach', { session: attachedKey.id });
      attachedKey = null;
    }

    deps.stream.end();
  };

  const reattachQuietly = async (key: SessionKey) => {
    try {
      await request(key);
    } catch {}
  };

  const reattach = (key: SessionKey) => {
    void reattachQuietly(key);
  };

  return {
    readAttachedKey: () => attachedKey,
    detach,
    reattach,

    attach: async (key) => {
      const service = deps.readService();

      if (deps.links.clientFor(key.daemon) === null) {
        deps.showStatusNotice(formatLinkState(key.daemon, deps.links.stateOf(key.daemon)));

        return;
      }

      if (isAttachedTo(key)) {
        service.send({ type: 'ATTACH', key });

        // The daemon marks a session read and clears its need when it hears an attach.
        void deps.sendQuiet(key.daemon, 'session.attach', { session: key.id, ...deps.readSize() });

        return;
      }

      detach();

      service.send({ type: 'ATTACH', key });

      try {
        await request(key);
      } catch (error) {
        attachedKey = null;

        deps.stream.end();
        deps.reportFailure(key.daemon, error);
        service.send({ type: 'OVERLAY' });
      }
    },

    showBase: () => {
      const service = deps.readService();
      const focused = deps.findFocused();

      if (focused === null || !focused.alive) {
        service.send({ type: 'HOME' });

        return;
      }

      const key = { daemon: focused.daemon, id: focused.id };

      service.send({ type: 'ATTACH', key });

      if (!isAttachedTo(key)) {
        reattach(key);
      }
    },
  };
}
