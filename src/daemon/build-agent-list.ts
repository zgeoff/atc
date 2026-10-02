import type { AgentAdapter, AgentKind } from '../agents/agent-adapter';

interface AgentCapabilities {
  // Only an installed agent can start a session.
  readonly spawn: boolean;
  readonly readTranscript: boolean;

  // Whether a session takes inbox messages through a tap.
  readonly message: boolean;
  readonly attach: boolean;
  readonly screen: boolean;
  readonly input: boolean;
}

export interface AgentEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: AgentKind;

  // Whether the agent's binary resolves, on PATH or at its configured path.
  readonly installed: boolean;
  readonly capabilities: AgentCapabilities;
  readonly models: Readonly<Record<string, string>> | null;
}

/**
 * One `agents.list` entry per registered adapter, in registration order. An
 * entry carries only the adapter's profile and what its interface offers,
 * so no environment value, credential, helper command, or base URL reaches
 * it. Every session runs in a PTY, so each agent can be attached, read as a
 * screen, and typed into.
 */
export function buildAgentList(
  adapters: readonly AgentAdapter[],
  isInstalled: (bin: string) => boolean,
): AgentEntry[] {
  return adapters.map((adapter) => {
    const profile = adapter.profile;
    const installed = profile === undefined ? false : isInstalled(profile.bin);

    return {
      id: adapter.id,
      label: profile?.label ?? adapter.id,
      kind: profile?.kind ?? pickKind(adapter.id),
      installed,
      capabilities: {
        spawn: installed,
        readTranscript: adapter.parseTranscriptLine !== undefined,
        message: adapter.takesMessages,
        attach: true,
        screen: true,
        input: true,
      },
      models: profile?.models ?? null,
    };
  });
}

// A stand-in adapter with no profile takes the kind its id matches, and any
// other id is a gateway.
function pickKind(id: string): AgentKind {
  return id === 'claude' || id === 'codex' || id === 'grok' ? id : 'gateway';
}
