import { expect, onTestFinished, test } from 'bun:test';
import { killProcessGroup } from './kill-process-group';
import { waitFor } from './wait-for';

test('it kills the leader of a group and a child the leader forked', async () => {
  const leader = Bun.spawn(
    ['sh', '-c', 'sleep 31 > /dev/null & echo "$!"; exec > /dev/null; wait'],
    {
      stdout: 'pipe',
      detached: true,
    },
  );

  onTestFinished(() => {
    killProcessGroup(leader.pid);
  });

  const output = await leader.stdout.text();

  const child = Number(output.trim());

  killProcessGroup(leader.pid);

  await leader.exited;

  await waitFor(() => {
    expect(() => process.kill(child, 0)).toThrow();
  });

  expect(leader.signalCode).toBe('SIGKILL');
});

test('it returns for a group with no process left', async () => {
  const leader = Bun.spawn(['true'], { detached: true });

  await leader.exited;

  expect(() => killProcessGroup(leader.pid)).not.toThrow();
});
