import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import type { DaemonFeature } from '../protocol/daemon-features';
import { isRecord } from '../shared/report';
import type { FleetCaller, ToolContext } from './types';

/**
 * A tool's result: the text every client reads, and for a tool whose result
 * is data, that data as an object for clients that read structured content.
 */
interface ToolResult {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>> | null;
}

export function runTool(
  caller: FleetCaller,
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return match(name)
    .with('atc_session_list', async () => {
      const ok = await caller.sendRequest('session.list');

      // The text stays the bare list older clients read; structured content
      // has to be an object.
      return {
        text: JSON.stringify(ok['sessions'], null, 2),
        structured: { sessions: ok['sessions'] },
      };
    })
    .with('atc_session_spawn', async () => {
      const rawAgent = args['agent'];
      const nested = args['detached'] !== true && ctx.callerSessionID !== null;

      const params = {
        cwd: args['cwd'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
        ...(rawAgent === undefined ? {} : { agent: rawAgent }),
        cols: 100,
        rows: 30,
      };

      const ok =
        nested && ctx.callerSessionID !== null
          ? await sendNestedSpawn(caller, params, ctx.callerSessionID)
          : await caller.sendRequest('session.spawn', params);

      return buildObjectResult(ok['session']);
    })
    .with('atc_session_input', async () => {
      await caller.sendRequest('session.input', {
        session: args['session'],
        d: `${typeof args['text'] === 'string' ? args['text'] : ''}\n`,
      });

      return { text: 'sent', structured: null };
    })
    .with('atc_session_screen', async () => {
      const ok = await caller.sendRequest('session.screen', { session: args['session'] });

      return {
        text: typeof ok['text'] === 'string' ? ok['text'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_session_update', async () => {
      await caller.sendRequest('session.update', {
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
      });

      return { text: 'updated', structured: null };
    })
    .with('atc_session_kill', async () => {
      await caller.sendRequest('session.kill', { session: args['session'] });

      return { text: 'killed', structured: null };
    })
    .with('atc_session_ack', async () => {
      await caller.sendRequest('session.ack', { session: args['session'] });

      return { text: 'acked', structured: null };
    })
    .with('atc_resume_command', async () => {
      const ok = await caller.sendRequest('session.resumeCommand', { session: args['session'] });

      return {
        text: typeof ok['command'] === 'string' ? ok['command'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_dirs_list', async () => {
      const ok = await caller.sendRequest('dirs.list');

      return { text: JSON.stringify(ok['dirs'], null, 2), structured: { dirs: ok['dirs'] } };
    })
    .with('atc_agents_list', async () => {
      await requireFeature(caller, 'agents.list', 'atc_agents_list');

      const ok = await caller.sendRequest('agents.list');

      return buildObjectResult(ok);
    })
    .with('atc_session_get', async () => {
      const ok = await caller.sendRequest('session.get', { session: args['session'] });

      return buildObjectResult(ok);
    })
    .with('atc_session_read', async () => {
      const ok = await caller.sendRequest('session.read', {
        session: args['session'],
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_events_read', async () => {
      if (typeof args['session'] === 'string' && args['session'] !== '') {
        await requireFeature(caller, 'events.session', "atc_events_read's session filter");
      }

      const ok = await caller.sendRequest('events.read', {
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
        ...(typeof args['session'] === 'string' ? { session: args['session'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_session_message', async () => {
      const given = args['from'];

      const from =
        ctx.sender.kind === 'default' && typeof given === 'string' && given !== ''
          ? given
          : ctx.sender.name;

      const ok = await caller.sendRequest('session.message', {
        session: args['session'],
        text: args['text'],
        from,
      });

      return buildObjectResult(ok);
    })
    .with('atc_message_get', async () => {
      if (typeof args['waitMs'] === 'number' && args['waitMs'] > 0) {
        await requireFeature(caller, 'message.wait', "atc_message_get's waitMs");
      }

      const ok = await caller.sendRequest('message.get', {
        message: args['message'],
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .otherwise(() => Promise.reject(new Error(`unknown tool '${name}'`)));
}

// A call that needs what the running daemon predates is refused with how to
// get it, rather than sent to a daemon that would ignore the option and
// answer as if it had been honoured. atc never restarts the daemon itself:
// a restart is the operator's call, because it respawns every session.
async function requireFeature(
  caller: FleetCaller,
  feature: DaemonFeature,
  what: string,
): Promise<void> {
  const features = await caller.readFeatures();

  if (!features.has(feature)) {
    throw new Error(
      `daemon_outdated: the running atc daemon is older than this atc and does not support ${what}. Restart the daemon to use it: press u in the atc TUI, which restores every session. Until then, call without it.`,
    );
  }
}

function buildObjectResult(value: unknown): ToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structured: isRecord(value) ? value : null,
  };
}

// The inherited id can point at a session another daemon hosts, or one
// this daemon no longer lists; the spawn then lands top-level instead of
// failing the tool call.
async function sendNestedSpawn(
  caller: FleetCaller,
  params: Readonly<Record<string, unknown>>,
  parent: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await caller.sendRequest('session.spawn', { ...params, parent });
  } catch (error) {
    if (error instanceof DaemonError && error.code === 'no_such_session') {
      return caller.sendRequest('session.spawn', params);
    }

    throw error;
  }
}
