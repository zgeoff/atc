import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';

interface StubRivalTapPushOptions {
  // The bare repository the rival pushes to.
  readonly remote: string;

  // The formula text the rival commits at Formula/atc.rb.
  readonly formula: string;
}

interface StubRivalTapPush {
  // A git config file whose hooks path runs the rival before the first push;
  // a test points GIT_CONFIG_GLOBAL at it.
  readonly gitConfig: string;
}

// The rival stands in for another branch's release that pushes to the tap
// between a release's clone and its push, so that push fails for real.
export function createStubRivalTapPush(
  directory: string,
  options: StubRivalTapPushOptions,
): StubRivalTapPush {
  const hooks = join(directory, 'hooks');
  const pending = join(directory, 'rival-pending');
  const formula = join(directory, 'rival-atc.rb');
  const clone = join(directory, 'rival');
  const gitConfig = join(directory, 'gitconfig');

  mkdirSync(hooks, { recursive: true });
  writeFileSync(formula, options.formula);
  writeFileSync(pending, '');
  writeFileSync(gitConfig, `[core]\n\thooksPath = ${hooks}\n`);

  createStubBin(
    hooks,
    'pre-push',
    [
      '#!/bin/sh',
      'set -eu',
      `[ -f ${toShellLiteral(pending)} ] || exit 0`,
      `rm ${toShellLiteral(pending)}`,
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE',
      `rm -rf ${toShellLiteral(clone)}`,
      `git -c core.hooksPath=/dev/null clone -q ${toShellLiteral(options.remote)} ${toShellLiteral(clone)}`,
      `mkdir -p ${toShellLiteral(join(clone, 'Formula'))}`,
      `cp ${toShellLiteral(formula)} ${toShellLiteral(join(clone, 'Formula/atc.rb'))}`,
      `git -C ${toShellLiteral(clone)} add Formula/atc.rb`,
      `git -C ${toShellLiteral(clone)} -c user.name=rival -c user.email=rival@example.com commit -q -m rival`,
      `git -C ${toShellLiteral(clone)} -c core.hooksPath=/dev/null push -q`,
      '',
    ].join('\n'),
  );

  return { gitConfig };
}

function toShellLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}
