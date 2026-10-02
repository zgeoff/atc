import { match } from 'ts-pattern';
import { DaemonError } from '../protocol/daemon-error';
import type { FleetCaller, ToolContext } from './types';

export function runTool(
  caller: FleetCaller,
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolContext,
): Promise<string> {
  return match(name)
    .with('atc_session_list', async () => {
      const ok = await caller.sendRequest('session.list');

      return JSON.stringify(ok['sessions'], null, 2);
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

      return JSON.stringify(ok['session'], null, 2);
    })
    .with('atc_session_input', async () => {
      await caller.sendRequest('session.input', {
        session: args['session'],
        d: `${typeof args['text'] === 'string' ? args['text'] : ''}\n`,
      });

      return 'sent';
    })
    .with('atc_session_screen', async () => {
      const ok = await caller.sendRequest('session.screen', { session: args['session'] });

      return typeof ok['text'] === 'string' ? ok['text'] : JSON.stringify(ok);
    })
    .with('atc_session_update', async () => {
      await caller.sendRequest('session.update', {
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
      });

      return 'updated';
    })
    .with('atc_session_kill', async () => {
      await caller.sendRequest('session.kill', { session: args['session'] });

      return 'killed';
    })
    .with('atc_session_ack', async () => {
      await caller.sendRequest('session.ack', { session: args['session'] });

      return 'acked';
    })
    .with('atc_resume_command', async () => {
      const ok = await caller.sendRequest('session.resumeCommand', { session: args['session'] });

      return typeof ok['command'] === 'string' ? ok['command'] : JSON.stringify(ok);
    })
    .with('atc_dirs_list', async () => {
      const ok = await caller.sendRequest('dirs.list');

      return JSON.stringify(ok['dirs'], null, 2);
    })
    .with('atc_session_get', async () => {
      const ok = await caller.sendRequest('session.get', { session: args['session'] });

      return JSON.stringify(ok, null, 2);
    })
    .with('atc_session_read', async () => {
      const ok = await caller.sendRequest('session.read', {
        session: args['session'],
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });

      return JSON.stringify(ok, null, 2);
    })
    .with('atc_events_read', async () => {
      const ok = await caller.sendRequest('events.read', {
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
      });

      return JSON.stringify(ok, null, 2);
    })
    .with('atc_session_message', async () => {
      const given = args['from'];
      const from = typeof given === 'string' && given !== '' ? given : ctx.defaultFrom;

      const ok = await caller.sendRequest('session.message', {
        session: args['session'],
        text: args['text'],
        from,
      });

      return JSON.stringify(ok, null, 2);
    })
    .with('atc_message_get', async () => {
      const ok = await caller.sendRequest('message.get', { message: args['message'] });

      return JSON.stringify(ok, null, 2);
    })
    .otherwise(() => Promise.reject(new Error(`unknown tool '${name}'`)));
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
