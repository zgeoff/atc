import { expect, mock, test } from 'bun:test';
import { readNamedDaemon } from './read-named-daemon';
import { buildMockRemoteDaemon } from './test-utils/build-mock-remote-daemon';

test('it returns the daemon the name selects and exits nothing', () => {
  const daemon = buildMockRemoteDaemon({ name: 'box' });
  const exit = mock<(code: number) => void>();

  const picked = readNamedDaemon('box', 'atc mcp', {
    loadConfig: () => ({ daemons: new Map([['box', daemon]]), daemonErrors: [] }),
    configFile: '/home/a/.config/atc/config.json',
    io: { printError: () => {}, exit },
  });

  expect(picked).toStrictEqual(daemon);
  expect(exit).not.toHaveBeenCalled();
});

test('it prints the refusal of an unknown name under the command and exits 1', () => {
  const printError = mock<(line: string) => void>();
  const exit = mock<(code: number) => void>();

  const picked = readNamedDaemon('lab', 'atc mcp', {
    loadConfig: () => ({
      daemons: new Map([['box', buildMockRemoteDaemon({ name: 'box' })]]),
      daemonErrors: [],
    }),
    configFile: '/home/a/.config/atc/config.json',
    io: { printError, exit },
  });

  expect(picked).toBeNull();

  expect(printError).toHaveBeenCalledExactlyOnceWith(
    "atc mcp: the daemons map of /home/a/.config/atc/config.json holds no daemon 'lab'; it holds box. atc did not fall back to the local daemon.",
  );

  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
