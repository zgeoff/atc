import type { SessionID } from '@atcx/contract';
import type { SessionRegistry } from './create-session-registry';

export type ResumeCommand =
  | { readonly command: string }
  | { readonly refusal: 'missing' }
  | { readonly refusal: 'unsupported'; readonly reason: string };

export function planResumeCommand(
  registry: Pick<SessionRegistry, 'sessions' | 'isLocalTarget' | 'findAdapter'>,
  id: SessionID,
): ResumeCommand {
  const session = registry.sessions.find((x) => x.id === id);

  if (!session) {
    return { refusal: 'missing' };
  }

  // The session's folder and any settings file the command passes are on another machine than
  // the one the command would run on.
  if (!registry.isLocalTarget(session.target)) {
    return {
      refusal: 'unsupported',
      reason: `session '${id}' runs on target '${session.target}', so it cannot resume outside atc on this machine`,
    };
  }

  const command =
    registry
      .findAdapter(session.agent)
      ?.planResumeCommand(session.cwd, session.agentSessionID, session.pluginDirs ?? []) ?? null;

  // Some agents have no outside command, such as a gateway that signs in only through the
  // daemon's broker.
  if (command === null) {
    return {
      refusal: 'unsupported',
      reason: `agent '${session.agent}' of session '${id}' cannot resume outside atc`,
    };
  }

  return { command };
}
