export interface RestartPlan {
  readonly pid: number | null;

  readonly socketPath: string | null;

  readonly answer: DaemonAnswer | null;

  readonly sessions: readonly PlanSession[] | null;

  readonly callerSession: string | null;

  readonly replacement: ReplacementPlan;
}

export type DaemonAnswer =
  | {
      readonly kind: 'ok';
      readonly build: string;
      readonly protocol: number;
      readonly major: number;
    }
  | { readonly kind: 'refused'; readonly message: string };

export interface PlanSession {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

export type ReplacementPlan =
  | {
      readonly kind: 'unit';
      readonly unit: string;
      readonly pid: number;
      readonly execStart: string | null;
    }
  | { readonly kind: 'plain'; readonly build: string; readonly command: string };
