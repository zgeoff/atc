// oxlint-disable zgeoff/test-beside-module -- a daemon.ts topic test: the answers to session.resumeCommand
import { expect, test } from 'bun:test';
import { buildStubExecutionProvider } from '@atc/execution-local/testing';
import { buildMockAgentAdapter, getRecord } from '@atc/test-utils';
import { startTestDaemon } from '../test-utils/start-test-daemon';

test('it answers the adapter command for a session on the daemon machine', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-resume-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        buildResumeCommand: (cwd) => `cd '${cwd}' && claude --resume`,
      }),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const answer = await daemon.client.sendRequest('session.resumeCommand', {
    session: getRecord(spawned, 'session')['id'],
  });

  expect(answer).toStrictEqual({ command: `cd '${daemon.dir}' && claude --resume` });
});

test('it refuses the command for a session on another machine as unsupported', async () => {
  const provider = buildStubExecutionProvider({ kind: 'imp-like', remote: true });

  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-resume-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        buildResumeCommand: (cwd) => `cd '${cwd}' && claude --resume`,
      }),
      targets: [{ id: 'box', kind: provider.kind, options: {}, identity: 'test:box', provider }],
      defaultTarget: 'box',
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  expect(daemon.client.sendRequest('session.resumeCommand', { session: id })).rejects.toMatchObject(
    {
      code: 'unsupported',
      message: `session '${id}' runs on target 'box', so it cannot resume outside atc on this machine`,
    },
  );
});

test('it refuses the command for an agent that builds none as unsupported', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-resume-',
    options: () => ({
      adapter: buildMockAgentAdapter({ buildResumeCommand: () => null }),
    }),
  });

  const spawned = await daemon.client.sendRequest('session.spawn', {
    cwd: daemon.dir,
    cols: 80,
    rows: 24,
  });

  const id = String(getRecord(spawned, 'session')['id']);

  expect(daemon.client.sendRequest('session.resumeCommand', { session: id })).rejects.toMatchObject(
    {
      code: 'unsupported',
      message: `agent 'claude' of session '${id}' cannot resume outside atc`,
    },
  );
});

test('it answers a session id the daemon does not hold as no such session', async () => {
  const daemon = await startTestDaemon({
    prefix: 'atc-daemon-resume-',
    options: () => ({
      adapter: buildMockAgentAdapter({
        buildResumeCommand: (cwd) => `cd '${cwd}' && claude --resume`,
      }),
    }),
  });

  expect(
    daemon.client.sendRequest('session.resumeCommand', { session: 'nonexistent' }),
  ).rejects.toMatchObject({ code: 'no_such_session', message: "no session 'nonexistent'" });
});
