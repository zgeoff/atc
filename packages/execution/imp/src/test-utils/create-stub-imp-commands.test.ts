import { expect, test } from 'bun:test';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';
import { setupTempDir } from '@atc/core/test-utils/setup-temp-dir';
import { waitFor } from '@atc/core/test-utils/wait-for';
import { createStubImpCommands } from './create-stub-imp-commands';
import { createStubImpFleet } from './create-stub-imp-fleet';

async function setupTest() {
  const calls: string[] = [];
  const reported: string[] = [];

  const fleet = createStubImpFleet({
    principal: 'atc-daemon',
    now: () => 1,
    calls,
    createSpecs: [],
  });

  const commands = createStubImpCommands({
    calls,
    imps: fleet.imps,
    report: (line) => {
      reported.push(line);
    },
  });

  registerTestCleanup(async () => {
    commands.stopCommandHold();

    await Promise.all(commands.kill().map((subprocess) => subprocess.exited));

    for (const name of fleet.collectImpNames()) {
      await fleet.destroyImp(name);
    }
  });

  await fleet.createImp({ name: 'imp-a' });

  return { commands, fleet, calls, reported };
}

test('it runs a command and returns its output and exit code', async () => {
  const ctx = await setupTest();

  const result = await ctx.commands.runCommand('imp-a', {
    argv: ['sh', '-c', 'echo out; echo err >&2; exit 3'],
  });

  expect({
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  }).toStrictEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
});

test('it records each command it runs', async () => {
  const ctx = await setupTest();

  await ctx.commands.runCommand('imp-a', { argv: ['true'] });

  expect(ctx.calls).toStrictEqual(['imps.create imp-a', 'exec.run imp-a true']);
});

test('it feeds a command the stdin it is given', async () => {
  const ctx = await setupTest();

  const result = await ctx.commands.runCommand('imp-a', {
    argv: ['cat'],
    stdin: new TextEncoder().encode('piped'),
  });

  expect(new TextDecoder().decode(result.stdout)).toBe('piped');
});

test('it runs a command with the guest PATH and not the one of the daemon', async () => {
  const ctx = await setupTest();

  ctx.commands.setGuestPath('/guest/bin');

  const result = await ctx.commands.runCommand('imp-a', { argv: ['/usr/bin/env'] });

  expect(new TextDecoder().decode(result.stdout)).toInclude('PATH=/guest/bin\n');
});

test('it runs a command with the guest home as HOME and as its working directory', async () => {
  const ctx = await setupTest();

  const temporaryDirectory = setupTempDir('atc-stub-imp-commands-');

  ctx.commands.setHomeDir(temporaryDirectory.path);

  const result = await ctx.commands.runCommand('imp-a', {
    argv: ['sh', '-c', 'echo $HOME; pwd -P'],
  });

  expect(new TextDecoder().decode(result.stdout).split('\n')[0]).toBe(temporaryDirectory.path);
});

test('it refuses a command on an imp it does not hold', async () => {
  const ctx = await setupTest();

  expect(ctx.commands.runCommand('imp-b', { argv: ['true'] })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it refuses a command on an imp that is not running', async () => {
  const ctx = await setupTest();

  await ctx.fleet.suspendImp('imp-a');

  expect(ctx.commands.runCommand('imp-a', { argv: ['true'] })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'sleeping', allowed: ['running'] },
  });
});

test('it fails a command whose argv holds the failure text without running it', async () => {
  const ctx = await setupTest();

  ctx.commands.setCommandFailure('touch');

  const result = await ctx.commands.runCommand('imp-a', { argv: ['touch', '/nonexistent/file'] });

  expect({ code: result.code, stderr: new TextDecoder().decode(result.stderr) }).toStrictEqual({
    code: 1,
    stderr: 'the command failed\n',
  });
});

test('it runs a command again once the failure is cleared', async () => {
  const ctx = await setupTest();

  ctx.commands.setCommandFailure('true');
  ctx.commands.setCommandFailure(null);

  const result = await ctx.commands.runCommand('imp-a', { argv: ['true'] });

  expect(result.code).toBe(0);
});

test('it resolves a relative guest directory from the root', async () => {
  const ctx = await setupTest();

  expect(ctx.commands.resolveGuestCwd('work/tree')).toBe('/work/tree');
});

test('it leaves an absolute guest directory as it is', async () => {
  const ctx = await setupTest();

  expect(ctx.commands.resolveGuestCwd('/work/../tree')).toBe('/work/../tree');
});

test('it resolves a missing guest directory to the guest home, or to none without one', async () => {
  const ctx = await setupTest();

  const withoutHome = ctx.commands.resolveGuestCwd(undefined);

  ctx.commands.setHomeDir('/guest/home');

  expect({ withoutHome, withHome: ctx.commands.resolveGuestCwd(undefined) }).toStrictEqual({
    withoutHome: undefined,
    withHome: '/guest/home',
  });
});

test('it holds a command whose argv holds the hold text until the hold stops', async () => {
  const ctx = await setupTest();

  const hold = ctx.commands.startCommandHold('held');
  const running = ctx.commands.runCommand('imp-a', { argv: ['echo', 'held'] });

  const entered = await hold.entered;

  const heldCount = ctx.commands.countHeldCommands();

  hold.stop();

  const result = await running;

  expect({ entered, heldCount, stdout: new TextDecoder().decode(result.stdout) }).toStrictEqual({
    entered: 'echo held',
    heldCount: 1,
    stdout: 'held\n',
  });
});

test('it runs a command whose argv lacks the hold text while another is held', async () => {
  const ctx = await setupTest();

  ctx.commands.startCommandHold('held');

  const result = await ctx.commands.runCommand('imp-a', { argv: ['true'] });

  expect(result.code).toBe(0);
});

test('it refuses a second hold while one is active', async () => {
  const ctx = await setupTest();

  ctx.commands.startCommandHold('one');

  expect(() => ctx.commands.startCommandHold('two')).toThrowWithMessage(
    Error,
    'a hold on one is still active',
  );
});

test('it lets every held command run when the active hold stops', async () => {
  const ctx = await setupTest();

  const hold = ctx.commands.startCommandHold('held');
  const running = ctx.commands.runCommand('imp-a', { argv: ['echo', 'held'] });

  await hold.entered;

  ctx.commands.stopCommandHold();

  const result = await running;

  expect(result.code).toBe(0);
});

test('it kills a running command and returns it', async () => {
  const ctx = await setupTest();

  const running = ctx.commands.runCommand('imp-a', { argv: ['sleep', '30'] });

  await waitFor(() => {
    expect(ctx.calls).toContain('exec.run imp-a sleep 30');
  });

  const killed = ctx.commands.kill();

  const result = await running;

  expect({ count: killed.length, code: result.code }).toStrictEqual({
    count: 1,
    code: 137,
  });
});

test('it ends a command that gets past its hold after a stop as a killed one', async () => {
  const ctx = await setupTest();

  const hold = ctx.commands.startCommandHold('held');
  const running = ctx.commands.runCommand('imp-a', { argv: ['echo', 'held'] });

  await hold.entered;

  ctx.commands.kill();

  const result = await running;

  expect(result).toMatchObject({ code: 137 });
});

test('it reports no line when a stop finds only commands that have seen nothing of their end', async () => {
  const ctx = await setupTest();

  const running = ctx.commands.runCommand('imp-a', { argv: ['sleep', '30'] });

  await waitFor(() => {
    expect(ctx.calls).toContain('exec.run imp-a sleep 30');
  });

  ctx.commands.kill();

  await running;

  expect(ctx.reported).toStrictEqual([]);
});
