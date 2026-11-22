import type { TokenName } from './kit.ts';

export interface Palette {
  readonly top: TokenName;
  readonly left: TokenName;
  readonly right: TokenName;
}

export type AgentKind = 'claude' | 'codex' | 'grok';

export type Shade = '' | 'Dim' | 'Idle';

// The token names of one agent kind's cube colours, in one shade.
export function buildPalette(kind: AgentKind, shade: Shade): Palette {
  return { top: `${kind}Top${shade}`, left: `${kind}Left${shade}`, right: `${kind}Right${shade}` };
}
