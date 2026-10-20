import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupTempDir } from '@atc/test-utils';
import { readSystemdVersion } from './read-systemd-version';

// A directory for the program files each test writes.
function setupTest() {
  const temporaryDirectory = setupTempDir('atc-systemd-version-');

  return { directory: temporaryDirectory.path };
}

test('it reads the release from the shared library name a program links', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'systemd-run'),
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, ...Buffer.from('libsystemd-shared-261.2-1.so\0')]),
  );

  expect(readSystemdVersion(join(ctx.directory, 'systemd-run'))).toBe(261);
});

test('it finds no release in a program that links no systemd library', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'systemd-run'), '#!/bin/sh\nexec "$@"\n');

  expect(readSystemdVersion(join(ctx.directory, 'systemd-run'))).toBeNull();
});

test('it finds no release for a program that does not exist', () => {
  const ctx = setupTest();

  expect(readSystemdVersion(join(ctx.directory, 'systemd-run'))).toBeNull();
});
