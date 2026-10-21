import type { SessionID } from '@atc/core';
import type { SessionRegistry } from './create-session-registry';

// The command that resumes a session outside atc, or why there is none: no
// such session, or a session that cannot resume outside atc.
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

  // its folder, and any settings file the command would pass, sit on a
  // different machine than the one the command would run on
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

  // e.g. a gateway that signs in through impd's broker alone
  if (command === null) {
    return {
      refusal: 'unsupported',
      reason: `agent '${session.agent}' of session '${id}' cannot resume outside atc`,
    };
  }

  return { command };
}
