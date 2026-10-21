import type { AgentList } from './create-picker-actors';
import { openFirstSource, quitFlow, renderFlow } from './navigate-picker';
import type { AgentPick, PickerFlow } from './picker-flow';

// Asks the daemon for the agents, targets, and sources it offers, and draws
// the agent step while the answer is on its way.
export function openAgentMenu(flow: PickerFlow) {
  flow.ctx.agentStepWait = 'reading agents…';

  flow.effects.push({ kind: 'request', request: { kind: 'agents' } });

  renderFlow(flow, true);
}

// Opens the menu on the agents the daemon can start. One such agent is no
// choice to make, so the flow goes on with it.
export function applyAgentList(flow: PickerFlow, list: AgentList | null, failure: string | null) {
  const ctx = flow.ctx;
  const deps = flow.deps;

  ctx.agentStepWait = null;
  ctx.listedAgents = list?.agents ?? [];
  ctx.listedTargets = list?.targets ?? [];
  ctx.sources = list?.sources ?? [];
  ctx.picks = collectAgentPicks(ctx.listedAgents);

  // A last-used agent the daemon cannot start is not in the menu, so the
  // selection falls to the first one it can.
  ctx.selected = Math.max(
    0,
    ctx.picks.findIndex((pick) => pick.agent === deps.getLastUsedAgent()),
  );

  ctx.agent = ctx.picks[ctx.selected]?.agent ?? deps.getLastUsedAgent();

  if (failure !== null) {
    flow.effects.push({ kind: 'log', line: `agent list failed: ${failure}` });

    ctx.refusal = `cannot read the agents: ${failure} · esc cancel`;
  } else if (ctx.picks.length === 1) {
    openFirstSource(flow);

    return;
  }

  renderFlow(flow);
}

export function applyAgentSubmit(flow: PickerFlow) {
  const pick = flow.ctx.picks[flow.ctx.selected];

  // With no agent the daemon can start the menu is empty and there is
  // nothing to spawn.
  if (pick === undefined) {
    return;
  }

  flow.ctx.agent = pick.agent;

  openFirstSource(flow);
}

export function applyAgentCancel(flow: PickerFlow) {
  quitFlow(flow);
}

// The agents the daemon lists as installed and able to start on some
// target, in its order.
function collectAgentPicks(agents: AgentList['agents']): AgentPick[] {
  return agents.flatMap((agent) =>
    agent.installed && agent.capabilities.spawn ? [{ agent: agent.id, label: agent.label }] : [],
  );
}
