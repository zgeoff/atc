// What a restart is about to stop and what it starts in its place.
export interface RestartPlan {
  // The pid of the daemon to stop, or null when no live pid is recorded.
  readonly pid: number | null;

  // The socket that answered the handshake, or null when none did.
  readonly socketPath: string | null;

  // How the daemon answered this build's handshake.
  readonly answer: DaemonAnswer | null;

  // The session list the daemon returned, or null when it could not be read.
  readonly sessions: readonly PlanSession[] | null;

  // The session the restart was run from, when it runs inside one.
  readonly callerSession: string | null;

  readonly replacement: ReplacementPlan;
}

export type DaemonAnswer =
  | { readonly kind: 'ok'; readonly build: string; readonly protocol: number }
  | { readonly kind: 'refused'; readonly message: string };

export interface PlanSession {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

export type ReplacementPlan =
  | { readonly kind: 'unit'; readonly unit: string; readonly execStart: string | null }
  | { readonly kind: 'plain'; readonly build: string; readonly command: string };
