import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { waitFor } from '@atc/core/test-utils/wait-for';
import type { ImpSessionOutcome, ImpSessionRequest, ImpSessionStarted } from '../port/imp-port';
import { answerStubSession } from './answer-stub-session';
import type { StubSessionContext, StubSessionFaults } from './answer-stub-session';
import { createStubImpCommands } from './create-stub-imp-commands';
import { createStubImpFleet } from './create-stub-imp-fleet';
import type { StubConnection } from './stub-imp';

type StartRequest = Extract<ImpSessionRequest, { readonly kind: 'start' }>;

// A context over a fleet holding one running imp, and the means to make a
// request and a connection that records what it is sent. Every process the
// sessions started is killed when the test finishes.
async function setupTest(settings: StubSessionContext['settings']) {
  const calls: string[] = [];

  const fleet = createStubImpFleet({
    principal: 'atc-daemon',
    now: () => 1,
    calls,
    createSpecs: [],
  });

  const commands = createStubImpCommands({ calls, imps: fleet.imps, report: () => {} });

  const faults: StubSessionFaults = {
    drops: { count: 0, closeCode: 1011 },
    nextMalformedFailure: null,
    nextFailure: null,
    brokerFailing: false,
  };

  const context: StubSessionContext = { faults, fleet, commands, settings };

  registerTestCleanup(async () => {
    for (const name of fleet.collectImpNames()) {
      await fleet.destroyImp(name);
    }
  });

  const target = { name: 'imp-a', session: 'agent', cols: 80, rows: 24 };

  await fleet.createImp({ name: target.name });

  const buildStart = (overrides: Partial<StartRequest> = {}): StartRequest => ({
    kind: 'start',
    ...target,
    argv: ['cat'],
    env: {},
    cwd: '/',
    ...overrides,
  });

  const buildAttach = (
    overrides: Partial<Extract<ImpSessionRequest, { readonly kind: 'attach' }>> = {},
  ): ImpSessionRequest => ({ kind: 'attach', ...target, wake: true, ...overrides });

  // Answers a request on a new connection that records what it is sent;
  // overrides replace the members of the connection.
  const answer = (request: ImpSessionRequest, overrides: Partial<StubConnection> = {}) => {
    const outcomes: ImpSessionOutcome[] = [];
    const started: ImpSessionStarted[] = [];
    const output: string[] = [];

    const connection: StubConnection = {
      handlers: {
        onStarted: (start) => {
          started.push(start);
        },
        onOutput: (data) => {
          output.push(new TextDecoder().decode(data));
        },
      },
      sent: 0,
      finished: false,
      process: null,
      stop: (outcome) => {
        connection.finished = true;

        outcomes.push(outcome);
      },
      stopMalformed: (outcome) => {
        connection.finished = true;

        outcomes.push(outcome);
      },
      ...overrides,
    };

    answerStubSession(context, request, connection);

    return { outcomes, started, output };
  };

  return { fleet, faults, buildStart, buildAttach, answer };
}

test('it starts a process and answers the connection that asked, as the creator', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart());

  expect(run.started).toMatchObject([
    { created: true, output: { continuity: 'offsets', offset: 0 } },
  ]);
});

test('it sends the output of a process to the connection that holds it', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart({ argv: ['echo', 'hello'] }));

  await waitFor(() => {
    expect(run.output.join('')).toInclude('hello');
  });
});

test('it ends the connection with the exit of its process', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart({ argv: ['sh', '-c', 'exit 4'] }));

  await waitFor(() => {
    expect(run.outcomes).toMatchObject([{ kind: 'exit', code: 4 }]);
  });
});

test('it answers without continuity when the agent has none', async () => {
  const ctx = await setupTest({ continuity: 'none', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart());

  expect(run.started).toMatchObject([{ output: { continuity: 'none' } }]);
});

test('it answers nothing to a connection that has finished', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart(), { finished: true });

  expect({ started: run.started, sessions: ctx.fleet.getImp('imp-a').sessions.size }).toStrictEqual(
    {
      started: [],
      sessions: 0,
    },
  );
});

test('it drops the next requests with the close code while drops remain', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.faults.drops = { count: 1, closeCode: 1011 };

  const first = ctx.answer(ctx.buildStart());
  const second = ctx.answer(ctx.buildStart());

  expect({
    first: first.outcomes,
    second: second.outcomes,
    started: second.started.length,
  }).toStrictEqual({
    first: [{ kind: 'closed', reason: 'code 1011', closeCode: 1011 }],
    second: [],
    started: 1,
  });
});

test('it refuses the next request with the failure a test set, once', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.faults.nextFailure = {
    refusal: { code: 'FORBIDDEN', data: { reason: 'scope' } },
    message: 'no',
  };

  const first = ctx.answer(ctx.buildStart());
  const second = ctx.answer(ctx.buildStart());

  expect({ first: first.outcomes, secondStarted: second.started.length }).toStrictEqual({
    first: [{ kind: 'failed', message: 'no', code: 'FORBIDDEN', data: { reason: 'scope' } }],
    secondStarted: 1,
  });
});

test('it refuses the next request with a malformed failure a test set', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.faults.nextMalformedFailure = { code: 'WEIRD', data: 7 };

  const run = ctx.answer(ctx.buildStart());

  expect(run.outcomes).toStrictEqual([
    { kind: 'failed', code: 'WEIRD', message: 'impd refused the session (WEIRD)', data: 7 },
  ]);
});

test('it refuses a request for an imp it does not hold', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart({ name: 'imp-b' }));

  expect(run.outcomes).toMatchObject([{ kind: 'failed', code: 'NOT_FOUND' }]);
});

test('it refuses an attach that may not wake a sleeping imp', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  await ctx.fleet.suspendImp('imp-a');

  const run = ctx.answer(ctx.buildAttach({ wake: false }));

  expect(run.outcomes).toMatchObject([
    { kind: 'failed', code: 'INVALID_STATE', data: { state: 'sleeping' } },
  ]);
});

test('it wakes a sleeping imp for a request that may wake it', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  await ctx.fleet.suspendImp('imp-a');

  ctx.answer(ctx.buildStart());

  expect(ctx.fleet.findState('imp-a')).toBe('running');
});

test('it refuses an attach to a session the imp does not hold and says which boot', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildAttach());

  expect(run.outcomes).toMatchObject([
    { kind: 'failed', code: 'NO_SESSION', data: { bootId: ctx.fleet.getBootID('imp-a') } },
  ]);
});

test('it attaches a second connection to the running process as a joiner', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.answer(ctx.buildStart());

  const second = ctx.answer(ctx.buildAttach());

  expect(second.started).toMatchObject([{ created: false }]);
});

test('it detaches the connection a new attach takes the process from', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const first = ctx.answer(ctx.buildStart());

  ctx.answer(ctx.buildAttach());

  expect(first.outcomes).toMatchObject([{ kind: 'detached', reason: 'taken_over' }]);
});

test('it replays the ring from the offset an exact resume names, less the overlap', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 2 });

  const first = ctx.answer(ctx.buildStart({ argv: ['sh', '-c', 'printf abcdef; sleep 30'] }));

  await waitFor(() => {
    expect(first.output.join('')).toInclude('abcdef');
  });

  const generation = ctx.fleet.getGeneration('imp-a', 'agent');
  const end = ctx.fleet.getEnd('imp-a', 'agent');

  const second = ctx.answer(
    ctx.buildAttach({ resumeFrom: { executionGeneration: generation, offset: end } }),
  );

  expect({ resume: second.started[0]?.output, replayed: second.output.join('') }).toMatchObject({
    resume: { resume: { kind: 'exact' }, offset: end - 2 },
    replayed: 'ef',
  });
});

test('it answers a resume of another generation as a changed generation', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.answer(ctx.buildStart());

  const second = ctx.answer(
    ctx.buildAttach({ resumeFrom: { executionGeneration: 'other', offset: 0 } }),
  );

  expect(second.started[0]?.output).toMatchObject({ resume: { kind: 'generation_changed' } });
});

test('it refuses a resume offset past the end of the output', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.answer(ctx.buildStart());

  const second = ctx.answer(
    ctx.buildAttach({
      resumeFrom: {
        executionGeneration: ctx.fleet.getGeneration('imp-a', 'agent'),
        offset: 1_000_000,
      },
    }),
  );

  expect(second.outcomes).toMatchObject([{ kind: 'failed', code: 'INVALID_RESUME' }]);
});

test('it refuses a start that requires the broker on an imp with no grant', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart({ require: ['broker'] }));

  expect(run.outcomes).toMatchObject([
    {
      kind: 'failed',
      code: 'PRECONDITION_FAILED',
      data: { reason: 'broker_not_ready', detail: 'the imp holds no grant' },
    },
  ]);
});

test('it refuses a start that requires the broker while the broker fails', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.faults.brokerFailing = true;

  const run = ctx.answer(ctx.buildStart({ require: ['broker'] }));

  expect(run.outcomes).toMatchObject([{ data: { detail: 'the broker CA did not install' } }]);
});

test('it refuses a start that requires the broker and sets a broker variable itself', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.fleet.getImp('imp-a').grants.add('token-a');

  const run = ctx.answer(
    ctx.buildStart({ require: ['broker'], env: { HTTPS_PROXY: 'http://example.test' } }),
  );

  expect(run.outcomes).toMatchObject([{ data: { detail: 'HTTPS_PROXY' } }]);
});

test('it starts a process that requires the broker on an imp with a grant', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  ctx.fleet.getImp('imp-a').grants.add('token-a');

  const run = ctx.answer(ctx.buildStart({ require: ['broker'] }));

  expect(run.started).toHaveLength(1);
});

test('it ends the connection with a local error when a handler throws', async () => {
  const ctx = await setupTest({ continuity: 'offsets', resumeOverlap: 0 });

  const run = ctx.answer(ctx.buildStart(), {
    handlers: {
      onStarted: () => {
        throw new Error('handler failed');
      },
      onOutput: () => {},
    },
  });

  expect(run.outcomes).toStrictEqual([{ kind: 'local_error', detail: 'handler failed' }]);
});
