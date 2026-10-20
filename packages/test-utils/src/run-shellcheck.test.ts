import { expect, test } from 'bun:test';
import { runShellcheck } from './run-shellcheck';
import { setupTempDir } from './setup-temp-dir';
import { updateEnv } from './update-env';

test('it resolves with no findings for a clean program', async () => {
  const result = await runShellcheck('mkdir -p "$1" && exec "$@"');

  expect(result).toStrictEqual({ exitCode: 0, findings: [] });
});

test('it resolves with one line per finding for a program shellcheck flags', async () => {
  const result = await runShellcheck('rm -rf $1\ncd $2');

  expect(result).toStrictEqual({
    exitCode: 1,
    findings: [
      '-:1:8: note: Double quote to prevent globbing and word splitting. [SC2086]',
      "-:2:1: warning: Use 'cd ... || exit' or 'cd ... || return' in case cd fails. [SC2164]",
      '-:2:4: note: Double quote to prevent globbing and word splitting. [SC2086]',
    ],
  });
});

test('it checks a program as POSIX sh', async () => {
  const result = await runShellcheck('[[ -n "$1" ]] && echo set');

  expect(result.exitCode).toBe(1);
  expect(result.findings).toSatisfyAll((line: string) => line.endsWith('[SC3010]'));
});

test('it throws when shellcheck is not on the PATH', () => {
  const empty = setupTempDir('atc-shellcheck-path-');

  updateEnv('PATH', empty.path);

  expect(runShellcheck('true')).rejects.toThrowWithMessage(Error, /shellcheck is not on the PATH/u);
});
