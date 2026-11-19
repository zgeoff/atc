import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { waitFor } from '@atc/core/test-utils/wait-for';
import type { ImpSessionRequest } from '../port/imp-port';
import { createStubImpCommands } from './create-stub-imp-commands';
import { createStubImpFleet } from './create-stub-imp-fleet';
import { createStubImpSessions } from './create-stub-imp-sessions';

type StartRequest = Extract<ImpSessionRequest, { readonly kind: 'start' }>;

async function setupTest() {
  const calls: string[] = [];
  const sessionRequests: ImpSessionRequest[] = [];

  const fleet = createStubImpFleet({
    principal: 'atc-daemon',
    now: () => 1,
    calls,
    createSpecs: [],
  });

  const commands = createStubImpCommands({ calls, imps: fleet.imps, report: () => {} });

  const sessions = createStubImpSessions({
    calls,
    sessionRequests,
    context: { fleet, commands, settings: { continuity: 'offsets', resumeOverlap: 0 } },
  });

  registerTestCleanup(async () => {
    sessions.stopAnswerHold();
    sessions.stopUpgradeHold();

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

  const open = (request: ImpSessionRequest, gate?: () => boolean) => {
    const output: string[] = [];
    const started: boolean[] = [];

    const connection = sessions.openSession(
      request,
      {
        onStarted: (start) => {
          started.push(start.created);
        },
        onOutput: (data) => {
          output.push(new TextDecoder().decode(data));
        },
      },
      gate,
    );

    return { connection, output, started };
  };

  return { sessions, fleet, calls, sessionRequests, buildStart, open };
}

test('it starts the session a request names and records the request', async () => {
  const ctx = await setupTest();

  const request = ctx.buildStart();
  const run = ctx.open(request);

  await waitFor(() => {
    expect(run.started).toStrictEqual([true]);
  });

  expect({ calls: ctx.calls.at(-1), requests: ctx.sessionRequests }).toStrictEqual({
    calls: 'exec.start imp-a agent',
    requests: [request],
  });
});

test('it writes the bytes it is given to the process of the session', async () => {
  const ctx = await setupTest();

  const run = ctx.open(ctx.buildStart());

  await waitFor(() => {
    expect(run.started).toStrictEqual([true]);
  });

  run.connection.write(new TextEncoder().encode('ping\n'));

  await waitFor(() => {
    expect(run.output.join('')).toInclude('ping');
  });
});

test('it ends the session as closed by the client when it is closed', async () => {
  const ctx = await setupTest();

  const run = ctx.open(ctx.buildStart());

  run.connection.close();

  const outcome = await run.connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'closed by the client',
    closeCode: 1000,
  });
});

test('it ends the session with the exit of its process', async () => {
  const ctx = await setupTest();

  const run = ctx.open(ctx.buildStart({ argv: ['sh', '-c', 'exit 5'] }));

  const outcome = await run.connection.outcome;

  expect(outcome).toMatchObject({ kind: 'exit', code: 5 });
});

test('it sends nothing when the gate is closed', async () => {
  const ctx = await setupTest();

  const run = ctx.open(ctx.buildStart(), () => false);

  expect({ outcome: await run.connection.outcome, requests: ctx.sessionRequests }).toStrictEqual({
    outcome: { kind: 'closed', reason: 'closed before sending', closeCode: 1000 },
    requests: [],
  });
});

test('it sends nothing when the gate throws', async () => {
  const ctx = await setupTest();

  const run = ctx.open(ctx.buildStart(), () => {
    throw new Error('gate failed');
  });

  const outcome = await run.connection.outcome;

  expect(outcome.kind).toBe('closed');
});

test('it throws from the open while open failures remain', async () => {
  const ctx = await setupTest();

  ctx.sessions.setOpenFailures(1);

  expect(() => ctx.open(ctx.buildStart())).toThrowWithMessage(
    TypeError,
    'the authorization header is invalid',
  );
});

test('it opens again once the open failures are spent', async () => {
  const ctx = await setupTest();

  ctx.sessions.setOpenFailures(1);

  expect(() => ctx.open(ctx.buildStart())).toThrow();

  const run = ctx.open(ctx.buildStart({ argv: ['sh', '-c', 'exit 0'] }));

  const outcome = await run.connection.outcome;

  expect(outcome).toMatchObject({ kind: 'exit' });
});

test('it ends the connection unreachable while upgrade failures remain', async () => {
  const ctx = await setupTest();

  ctx.sessions.setUpgradeFailures(1);

  const run = ctx.open(ctx.buildStart());

  expect({ outcome: await run.connection.outcome, requests: ctx.sessionRequests }).toStrictEqual({
    outcome: { kind: 'unreachable', detail: 'the upgrade failed' },
    requests: [],
  });
});

test('it holds the requests until the upgrade hold stops', async () => {
  const ctx = await setupTest();

  ctx.sessions.startUpgradeHold();

  const run = ctx.open(ctx.buildStart());
  const held = { count: ctx.sessions.countHeldUpgrades(), requests: ctx.sessionRequests.length };

  ctx.sessions.stopUpgradeHold();

  await waitFor(() => {
    expect(run.started).toStrictEqual([true]);
  });

  expect({ held, after: ctx.sessions.countHeldUpgrades() }).toStrictEqual({
    held: { count: 1, requests: 0 },
    after: 0,
  });
});

test('it holds the answers until the answer hold stops', async () => {
  const ctx = await setupTest();

  ctx.sessions.startAnswerHold();

  const run = ctx.open(ctx.buildStart());

  await waitFor(() => {
    expect(ctx.sessions.countHeldAnswers()).toBe(1);
  });

  const startedWhileHeld = run.started.length;

  ctx.sessions.stopAnswerHold();

  await waitFor(() => {
    expect(run.started).toStrictEqual([true]);
  });

  expect({ startedWhileHeld, after: ctx.sessions.countHeldAnswers() }).toStrictEqual({
    startedWhileHeld: 0,
    after: 0,
  });
});

test('it times out the capability check of a start that requires the broker while failures remain', async () => {
  const ctx = await setupTest();

  ctx.sessions.setExecCheckFailures(1);

  const run = ctx.open(ctx.buildStart({ require: ['broker'] }));

  expect({
    outcome: await run.connection.outcome,
    failed: ctx.sessions.countFailedExecChecks(),
    requests: ctx.sessionRequests,
  }).toStrictEqual({
    outcome: { kind: 'unreachable', detail: 'system.info: The operation timed out.' },
    failed: 1,
    requests: [],
  });
});

test('it checks no capability of a start that requires nothing', async () => {
  const ctx = await setupTest();

  ctx.sessions.setExecCheckFailures(1);

  const run = ctx.open(ctx.buildStart());

  await waitFor(() => {
    expect(run.started).toStrictEqual([true]);
  });

  expect(ctx.sessions.countFailedExecChecks()).toBe(0);
});

test('it drops the next sessions with the close code', async () => {
  const ctx = await setupTest();

  ctx.sessions.setSessionDrops(1, 1011);

  const run = ctx.open(ctx.buildStart());

  const outcome = await run.connection.outcome;

  expect(outcome).toStrictEqual({
    kind: 'closed',
    reason: 'code 1011',
    closeCode: 1011,
  });
});

test('it refuses the next session with the refusal a test set', async () => {
  const ctx = await setupTest();

  ctx.sessions.setNextSessionFailure({ code: 'FORBIDDEN', data: { reason: 'scope' } }, 'no');

  const run = ctx.open(ctx.buildStart());

  const outcome = await run.connection.outcome;

  expect(outcome).toMatchObject({
    kind: 'failed',
    code: 'FORBIDDEN',
    message: 'no',
  });
});

test('it refuses the next session with a malformed refusal', async () => {
  const ctx = await setupTest();

  ctx.sessions.setNextMalformedSessionFailure('WEIRD', 7);

  const run = ctx.open(ctx.buildStart());

  const outcome = await run.connection.outcome;

  expect(outcome).toMatchObject({ kind: 'failed', code: 'WEIRD', data: 7 });
});

test('it refuses a start that requires the broker while the broker fails, until it recovers', async () => {
  const ctx = await setupTest();

  ctx.fleet.getImp('imp-a').grants.add('token-a');
  ctx.sessions.startBrokerFailure();

  const failing = ctx.open(ctx.buildStart({ require: ['broker'] }));

  const failed = await failing.connection.outcome;

  ctx.sessions.stopBrokerFailure();

  const recovered = ctx.open(ctx.buildStart({ require: ['broker'], session: 'again' }));

  await waitFor(() => {
    expect(recovered.started).toStrictEqual([true]);
  });

  expect(failed).toMatchObject({ kind: 'failed', code: 'PRECONDITION_FAILED' });
});
