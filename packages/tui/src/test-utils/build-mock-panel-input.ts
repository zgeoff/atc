import type { PanelInput } from '../session-list/types';

export function buildMockPanelInput(overrides: Partial<PanelInput> = {}): PanelInput {
  return {
    rows: [],
    selected: -1,
    grouping: 'flat',
    filter: null,
    jump: null,
    prompt: null,
    notice: null,
    daemonLine: null,
    updateAdvice: null,
    showDaemon: false,
    nowMs: 0,
    spinnerFrame: 0,
    readAgentLabel: (session) => session.agent,
    ...overrides,
  };
}
