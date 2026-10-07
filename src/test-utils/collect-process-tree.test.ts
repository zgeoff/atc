import { expect, onTestFinished, test } from 'bun:test';
import { collectProcessTree } from './collect-process-tree';
import { waitFor } from './wait-for';

// The tree is read from /proc, which only Linux has. A spawned child shows
// its own argv only once it has exec'd, so each read is retried until then.
test.skipIf(process.platform !== 'linux')(
  'it collects the argv and environment of a running child',
  async () => {
    const child = Bun.spawn(['sleep', '30'], {
      env: { ...process.env, ATC_TREE_PROBE: 'probe-value' },
    });

    onTestFinished(() => {
      child.kill('SIGKILL');
    });

    const tree = await waitFor(async () => {
      const read = await collectProcessTree(process.pid);

      expect(read).toPartiallyContain({ pid: child.pid, argv: ['sleep', '30'] });

      return read;
    });

    expect(tree.find((entry) => entry.pid === child.pid)?.env['ATC_TREE_PROBE']).toBe(
      'probe-value',
    );
  },
);

test.skipIf(process.platform !== 'linux')(
  'it collects the children and grandchildren of the root and leaves out the root itself',
  async () => {
    const child = Bun.spawn(['sh', '-c', 'sh -c "sleep 32 & wait" & sleep 31 & wait'], {
      detached: true,
    });

    onTestFinished(() => {
      process.kill(-child.pid, 'SIGKILL');
    });

    await waitFor(async () => {
      const tree = await collectProcessTree(child.pid);

      expect(tree.map((entry) => entry.argv)).toIncludeSameMembers([
        ['sh', '-c', 'sleep 32 & wait'],
        ['sleep', '31'],
        ['sleep', '32'],
      ]);
    });
  },
);
