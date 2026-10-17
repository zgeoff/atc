import { eventIterator, oc } from '@orpc/contract';
import { z } from 'zod';
import { AGENT_LIST_SCHEMA } from './agent-list';
import { ANSWER_VIEW_SCHEMA } from './answer-view';
import { DAEMON_ERROR_MAP } from './daemon-error-map';
import { DAEMON_EVENT_SCHEMA } from './daemon-event';
import { FLEET_ENTRY_VIEW_SCHEMA } from './fleet-entry-view';
import { FLEET_EVENT_SCHEMA } from './fleet-event';
import { GIT_PROBE_RESULT_SCHEMA } from './git-probe-result';
import { HELLO_RESULT_SCHEMA } from './hello-result';
import { MENU_VIEW_SCHEMA } from './menu-view';
import { MESSAGE_ANSWER_SCHEMA } from './message-answer';
import { MESSAGE_VIEW_SCHEMA } from './message-view';
import { NOTE_VIEW_SCHEMA } from './note-view';
import type { ProcedureMeta } from './procedure-meta';
import { PUBLISHED_RECORD_SCHEMA } from './published-record-schema';
import { REQUEST_PARAM_SCHEMAS } from './request-param-schemas';
import { SESSION_DESCRIPTOR_SCHEMA } from './session-descriptor';
import { SOURCE_CANDIDATE_SCHEMA } from './source-candidate';
import { SOURCE_INTERPRETATION_SCHEMA } from './source-interpretation';
import { SPAWN_ANSWER_SCHEMA } from './spawn-answer';
import { TRANSCRIPT_ROW_SCHEMA } from './transcript-row';

const EMPTY = z.object({});
const STRINGS = z.array(z.string()).readonly();

// A forget that destroys a host answers first with the token its confirming
// retry carries, and then with what it forgot.
const FORGET_CONFIRM = z.object({ confirmToken: z.string(), expiresAt: z.number() });
const FORGET_DONE = z.object({ forgotten: z.literal(true), destroyed: z.boolean() });

// The message a session's pending permission prompt shows.
const PENDING_PROMPT = z.object({ message: z.string() });

// A procedure open to principals that changes something and takes no key.
const ACT: ProcedureMeta = { access: 'principal', readOnly: false, keyed: false };
const READ: ProcedureMeta = { access: 'principal', readOnly: true, keyed: false };
const KEYED: ProcedureMeta = { access: 'principal', readOnly: false, keyed: true };
const OWNER: ProcedureMeta = { access: 'owner', readOnly: false, keyed: false };
const base = oc.$meta<ProcedureMeta>(ACT).errors(DAEMON_ERROR_MAP);
const P = REQUEST_PARAM_SCHEMAS;

// a procedure's path joined with dots is its request method;
// `sources.complete` and `events.subscribe` have no request method
export const DAEMON_CONTRACT = {
  daemon: {
    hello: base.meta(READ).input(P['daemon.hello']).output(HELLO_RESULT_SCHEMA),
    ping: base.meta(READ).input(P['daemon.ping']).output(EMPTY),
    quit: base.meta(OWNER).input(P['daemon.quit']).output(EMPTY),
    backup: base
      .meta(OWNER)
      .input(P['daemon.backup'])
      .output(z.object({ path: z.string(), bytes: z.number() })),
  },
  dirs: {
    list: base
      .meta(READ)
      .input(P['dirs.list'])
      .output(z.object({ dirs: STRINGS })),
  },
  agents: {
    list: base.meta(READ).input(P['agents.list']).output(AGENT_LIST_SCHEMA),
  },
  sources: {
    list: base
      .meta(READ)
      .input(P['sources.list'])
      .output(
        z.object({
          source: z.string(),
          scope: z.string().nullable(),
          candidates: z.array(SOURCE_CANDIDATE_SCHEMA).readonly(),
        }),
      ),
    interpret: base.meta(READ).input(P['sources.interpret']).output(SOURCE_INTERPRETATION_SCHEMA),

    // Completes a typed path against the daemon host's filesystem, with the
    // client's working directory as a hint the dirs source uses only when
    // the daemon is local.
    complete: base
      .meta(READ)
      .input(
        z.object({
          source: z.string(),
          input: z.string(),
          target: z.string().optional(),
          clientCwd: z.string().optional(),
        }),
      )
      .output(z.object({ completions: STRINGS })),
  },
  git: {
    probe: base.meta(READ).input(P['git.probe']).output(GIT_PROBE_RESULT_SCHEMA),
  },
  fleet: {
    list: base
      .meta(READ)
      .input(P['fleet.list'])
      .output(z.object({ fleet: z.array(FLEET_ENTRY_VIEW_SCHEMA).readonly() })),
    restore: base
      .meta(OWNER)
      .input(P['fleet.restore'])
      .output(z.object({ restored: z.number() })),
  },
  session: {
    list: base
      .meta(READ)
      .input(P['session.list'])
      .output(z.object({ sessions: z.array(SESSION_DESCRIPTOR_SCHEMA).readonly() })),
    spawn: base.meta(KEYED).input(P['session.spawn']).output(SPAWN_ANSWER_SCHEMA),
    kill: base.input(P['session.kill']).output(z.object({ stopped: z.boolean().optional() })),
    ack: base.input(P['session.ack']).output(EMPTY),
    forget: base.input(P['session.forget']).output(z.union([FORGET_CONFIRM, FORGET_DONE])),
    resumeCommand: base
      .meta(READ)
      .input(P['session.resumeCommand'])
      .output(z.object({ command: z.string() })),
    auth: {
      revoke: base
        .meta(OWNER)
        .input(P['session.auth.revoke'])
        .output(z.object({ revoked: z.literal(true) })),
      rebind: base
        .meta(OWNER)
        .input(P['session.auth.rebind'])
        .output(z.object({ revision: z.number(), restartPending: STRINGS })),
    },

    // renameSkipped holds why a requested rename did not apply: 'agent_named'
    // when the agent named the session itself. Other changes still applied.
    update: base
      .input(P['session.update'])
      .output(z.object({ renameSkipped: z.string().optional() })),
    scope: {
      add: base.input(P['session.scope.add']).output(z.object({ record: PUBLISHED_RECORD_SCHEMA })),
    },
    attach: base
      .input(P['session.attach'])
      .output(z.object({ cols: z.number(), rows: z.number() })),
    detach: base.input(P['session.detach']).output(EMPTY),
    input: base.input(P['session.input']).output(EMPTY),
    submit: base.input(P['session.submit']).output(EMPTY),
    resize: base.input(P['session.resize']).output(EMPTY),
    screen: base
      .meta(READ)
      .input(P['session.screen'])
      .output(z.object({ text: z.string(), cols: z.number(), rows: z.number() })),

    // A list longer than the screen is read with arrow keys that move the
    // cursor and put it back, so the read picks nothing and stays safe to
    // send again.
    menu: base
      .meta(READ)
      .input(P['session.menu'])
      .output(z.object({ menu: MENU_VIEW_SCHEMA.nullable() })),

    // menu is what the screen settles on after the last key pressed; partial
    // means the daemon could read only the part of it the screen shows
    choose: base.input(P['session.choose']).output(
      z.object({
        pressed: z.string(),
        menu: MENU_VIEW_SCHEMA.nullable(),
        partial: z.literal(true).optional(),
      }),
    ),
    eject: base.input(P['session.eject']).output(EMPTY),
    adopt: base.input(P['session.adopt']).output(EMPTY),
    get: base
      .meta(READ)
      .input(P['session.get'])
      .output(
        z.object({
          session: SESSION_DESCRIPTOR_SCHEMA,
          prompt: z.string().nullable(),
          lastActivityAt: z.number(),
          pending: PENDING_PROMPT.nullable(),
          result: z.string().nullable(),
          sessionRecord: PUBLISHED_RECORD_SCHEMA.nullable(),
        }),
      ),
    read: base
      .meta(READ)
      .input(P['session.read'])
      .output(
        z.object({
          rows: z.array(TRANSCRIPT_ROW_SCHEMA).readonly(),
          cursor: z.string(),
          more: z.boolean(),
        }),
      ),
    message: base.meta(KEYED).input(P['session.message']).output(MESSAGE_ANSWER_SCHEMA),
    tap: base.input(P['session.tap']).output(EMPTY),
  },
  permission: {
    respond: base.input(P['permission.respond']).output(EMPTY),
  },
  events: {
    read: base
      .meta(READ)
      .input(P['events.read'])
      .output(
        z.object({
          events: z.array(FLEET_EVENT_SCHEMA).readonly(),
          cursor: z.string(),
          more: z.boolean(),
        }),
      ),

    // The live events of one connection: session views, terminal output for
    // attached sessions, permission prompts, and inbox traffic.
    subscribe: base.meta(READ).input(EMPTY).output(eventIterator(DAEMON_EVENT_SCHEMA)),
  },
  message: {
    get: base.meta(READ).input(P['message.get']).output(MESSAGE_VIEW_SCHEMA),
    ack: base.input(P['message.ack']).output(MESSAGE_ANSWER_SCHEMA),
  },
  notice: {
    ack: base.input(P['notice.ack']).output(MESSAGE_ANSWER_SCHEMA),
  },
  note: {
    get: base.meta(READ).input(P['note.get']).output(NOTE_VIEW_SCHEMA),
  },
  answer: {
    get: base.meta(READ).input(P['answer.get']).output(ANSWER_VIEW_SCHEMA),
  },
};
