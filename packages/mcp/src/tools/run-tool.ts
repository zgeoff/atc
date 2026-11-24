import { createHash, randomUUID } from 'node:crypto';
import { isRecord } from '@atc/core';
import type { FleetClient } from '@atc/fleet-api';
import { AtcError } from '@atcx/contract/light';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { findCodedError } from '../errors/find-coded-error';
import { parseIdempotencyKey } from './parse-idempotency-key';
import { readEventTexts } from './read-event-texts';
import type { ToolContext } from './types';

interface ToolResult {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>> | null;
}

export function runTool(
  client: FleetClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolContext,
): Promise<ToolResult> {
  return match(name)
    .with('atc_sessions_list', async () => {
      const ok = await client.session.list({});

      // A caller that routes across named daemons adds each daemon's state,
      // so a daemon that is down never reads as one with no sessions.
      if (ok['daemons'] !== undefined) {
        return buildObjectResult({ sessions: ok['sessions'], daemons: ok['daemons'] });
      }

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
      const key = parseIdempotencyKey(args['idempotencyKey']);

      const params = {
        ...(typeof args['daemon'] === 'string' ? { daemon: args['daemon'] } : {}),
        ...(args['cwd'] === undefined ? {} : { cwd: args['cwd'] }),
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['prompt'] === 'string' ? { prompt: args['prompt'] } : {}),
        ...(rawAgent === undefined ? {} : { agent: rawAgent }),
        ...(args['model'] === undefined ? {} : { model: args['model'] }),
        ...(args['effort'] === undefined ? {} : { effort: args['effort'] }),
        ...(args['pluginDirs'] === undefined ? {} : { pluginDirs: args['pluginDirs'] }),
        idempotencyKey: key ?? randomUUID(),
        ...(args['target'] === undefined ? {} : { target: args['target'] }),
        ...(args['workspace'] === undefined ? {} : { workspace: args['workspace'] }),
        ...(args['trustClonedWorkspace'] === undefined
          ? {}
          : { trustClonedWorkspace: args['trustClonedWorkspace'] }),
        ...(args['scope'] === undefined ? {} : { scope: args['scope'] }),
        ...(args['atcAccess'] === undefined ? {} : { atcAccess: args['atcAccess'] }),
      };

      const ok =
        nested && ctx.callerSessionID !== null
          ? await sendNestedSpawn(client, params, ctx.callerSessionID)
          : await client.session.spawn(params);

      // The daemon puts warnings about changes a workspace left behind outside the session
      // object in its spawn reply, so they are copied into the session the caller gets.
      const warnings = ok['warnings'];

      const session =
        warnings === undefined || !isRecord(ok['session'])
          ? ok['session']
          : { ...ok['session'], warnings };

      return buildObjectResult(session);
    })
    .with('atc_terminal_type', async () => {
      await client.session.submit({
        session: args['session'],
        text: typeof args['text'] === 'string' ? args['text'] : '',
      });

      return buildObjectResult({ written: true });
    })
    .with('atc_terminal_choose', async () => {
      // A choice without a token could only be checked against a menu the
      // caller never read, so it presses nothing.
      if (
        args['menuToken'] === undefined &&
        (args['option'] !== undefined || args['label'] !== undefined || args['key'] !== undefined)
      ) {
        throw new AtcError(
          'bad_args',
          'a choice takes the menuToken of the menu it answers; call with session alone to read it',
        );
      }

      if (args['menuToken'] === undefined) {
        const ok = await client.session.menu({ session: args['session'] });

        return buildObjectResult({ menu: ok['menu'] });
      }

      const ok = await client.session.choose({
        session: args['session'],
        menuToken: args['menuToken'],
        ...(args['option'] === undefined ? {} : { option: args['option'] }),
        ...(args['label'] === undefined ? {} : { label: args['label'] }),
        ...(args['key'] === undefined ? {} : { key: args['key'] }),
      });

      return buildObjectResult({
        pressed: ok['pressed'],
        menu: ok['menu'],
        ...(ok['partial'] === true ? { partial: true } : {}),
      });
    })
    .with('atc_terminal_read', async () => {
      const ok = await client.session.screen({ session: args['session'] });

      return {
        text: typeof ok['text'] === 'string' ? ok['text'] : JSON.stringify(ok),
        structured: null,
      };
    })
    .with('atc_session_update', async () => {
      const ok = await client.session.update({
        session: args['session'],
        ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
        ...(typeof args['pinned'] === 'boolean' ? { pinned: args['pinned'] } : {}),
        ...(args['parent'] === null ? { parent: null } : {}),
      });

      if (ok['renameSkipped'] === 'agent_named') {
        return {
          text: 'updated, not renamed: the agent named this session itself with /rename, and a name the agent sets wins over one set here. Any pin or detach in the call applied.',
          structured: null,
        };
      }

      return { text: 'updated', structured: null };
    })
    .with('atc_session_scope_add', async () => {
      const ok = await client.session.scope.add({
        session: args['session'],
        scope: args['scope'],
      });

      return { text: JSON.stringify(ok), structured: ok };
    })
    .with('atc_session_stop', async () => {
      const ok = await client.session.kill({
        session: args['session'],
      });

      return buildObjectResult({ stopped: ok['stopped'] === true });
    })
    .with('atc_session_adopt', async () => {
      await client.session.adopt({ session: args['session'] });

      return buildObjectResult({ adopted: true });
    })
    .with('atc_session_auth_rebind', async () => {
      const ok = await client.session.auth.rebind({ session: args['session'] });

      return buildObjectResult({
        revision: ok['revision'],
        restartPending: Array.isArray(ok['restartPending']) ? ok['restartPending'] : [],
      });
    })
    .with('atc_session_forget', async () => {
      const params = {
        session: args['session'],
        ...(typeof args['confirmToken'] === 'string' ? { confirmToken: args['confirmToken'] } : {}),
      };

      const ok = await sendGuardedForget(client, params, args['stop'] === true);

      return buildObjectResult(ok);
    })
    .with('atc_session_mark_read', async () => {
      await client.session.ack({ session: args['session'] });

      return { text: 'marked read', structured: null };
    })
    .with('atc_recent_dirs_list', async () => {
      const params = typeof args['daemon'] === 'string' ? { daemon: args['daemon'] } : {};

      const ok = await client.dirs.list(params);

      return { text: JSON.stringify(ok['dirs'], null, 2), structured: { dirs: ok['dirs'] } };
    })
    .with('atc_daemons_list', async () => {
      invariant(
        client.daemons,
        'the daemons tool is listed only where the router serves daemons.list',
      );

      const ok = await client.daemons.list({});

      return buildObjectResult(ok);
    })
    .with('atc_spawn_options_get', async () => {
      const ok = await client.agents.list({});

      return buildObjectResult(ok);
    })
    .with('atc_session_get', async () => {
      const ok = await client.session.get({ session: args['session'] });

      return buildObjectResult(ok);
    })
    .with('atc_transcript_read', async () => {
      const ok = await client.session.read({
        session: args['session'],
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .with('atc_events_read', async () => {
      const previewOnly = args['previewOnly'] === true;

      const ok = await client.events.read({
        ...(typeof args['cursor'] === 'string' ? { cursor: args['cursor'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
        ...(typeof args['session'] === 'string' ? { session: args['session'] } : {}),
      });

      const page = previewOnly ? ok : await readEventTexts(client, ok);

      return buildObjectResult(buildPageWithoutTextHandles(page));
    })
    .with('atc_message_send', async () => {
      const key = parseIdempotencyKey(args['idempotencyKey']);

      const ok = await client.session.message({
        session: args['session'],
        text: args['text'],
        idempotencyKey: key ?? randomUUID(),
      });

      return buildObjectResult(ok);
    })
    .with('atc_message_get', async () => {
      const ok = await client.message.get({
        message: args['message'],
        ...(typeof args['waitMs'] === 'number' ? { waitMs: args['waitMs'] } : {}),
      });

      return buildObjectResult(ok);
    })
    .otherwise(() => Promise.reject(new Error(`unknown tool '${name}'`)));
}

function buildObjectResult(value: unknown): ToolResult {
  return {
    text: JSON.stringify(value, null, 2),
    structured: isRecord(value) ? value : null,
  };
}

// the inherited id can point at a session another daemon hosts, or one this
// daemon no longer lists; the spawn then lands top-level instead of failing.
async function sendNestedSpawn(
  client: FleetClient,
  params: Readonly<Record<string, unknown>>,
  parent: string,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await client.session.spawn({ ...params, parent });
  } catch (error) {
    // an answer that holds an effect id is a keyed spawn that already ran, which a
    // top-level spawn would only duplicate.
    const coded = findCodedError(error);

    if (coded?.code === 'no_such_session' && coded.data['effectRef'] === undefined) {
      return client.session.spawn(buildTopLevelParams(params));
    }

    throw error;
  }
}

function buildTopLevelParams(
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const key = params['idempotencyKey'];

  if (typeof key !== 'string') {
    return params;
  }

  // the top-level spawn has a different payload, so it runs under its own key. A retry
  // derives the same key and replays it instead of conflicting with the nested key,
  // and the fixed-length hash fits the daemon's cap whatever the caller's length.
  const digest = createHash('sha256').update(key).digest('hex');

  return { ...params, idempotencyKey: `top-level:${digest}` };
}

const SESSION_PINNED_REFUSAL =
  'session_pinned: the session is pinned, or is a sub-session of a pinned session and the call does not come from inside its parent. Unpin it, or detach the sub-session with parent null, through atc_session_update before forgetting it.';

const SESSION_LIVE_REFUSAL =
  'session_live: the session is live. Pass stop: true to stop and forget it.';

// the daemon checks pinned and live in the same step that forgets, so a pin or
// revive that lands just before the forget still refuses it.
async function sendGuardedForget(
  client: FleetClient,
  params: Readonly<Record<string, unknown>>,
  stops: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  try {
    return await client.session.forget({ ...params, ...(stops ? { stop: true } : {}) });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) {
      throw error;
    }

    if (error.code === 'session_pinned') {
      throw new Error(SESSION_PINNED_REFUSAL, { cause: error });
    }

    if (error.code === 'session_live') {
      throw new Error(SESSION_LIVE_REFUSAL, { cause: error });
    }

    throw error;
  }
}

// Only a text read takes the per-event note and answer handles, and no tool offers that read
// to a caller, so the handles are useless to one.
function buildPageWithoutTextHandles(
  page: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const events: unknown = page['events'];

  if (!Array.isArray(events)) {
    return page;
  }

  return {
    ...page,
    events: events.map((event: unknown) => {
      if (!isRecord(event)) {
        return event;
      }

      const { note: _note, answer: _answer, ...rest } = event;

      return rest;
    }),
  };
}
