import { expect, onTestFinished, test } from 'bun:test';
import { collectProcessTree } from './collect-process-tree';
import type { TreeProcess } from './collect-process-tree';
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
  'it collects a grandchild started by a child',
  async () => {
    const child = Bun.spawn(['sh', '-c', 'sleep 31 & wait']);

    onTestFinished(() => {
      Bun.spawnSync(['pkill', '-KILL', '-P', String(child.pid)]);
      child.kill('SIGKILL');
    });

    await waitFor(async () => {
      const tree = await collectProcessTree(process.pid);

      expect(tree).toPartiallyContain({ argv: ['sleep', '31'] });
    });
  },
);

test.skipIf(process.platform !== 'linux')(
  'it leaves out the root and every process outside its tree',
  async () => {
    const tree = await collectProcessTree(process.pid);

    expect(tree).toSatisfyAll(
      (entry: TreeProcess) =>
        entry.pid !== process.pid && entry.pid !== process.ppid && entry.pid !== 1,
    );
  },
);
