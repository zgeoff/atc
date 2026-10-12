import { expect, test } from 'bun:test';
import { parseMismatchBuild } from './parse-mismatch-build';

test('it reads the daemon build and protocol from a refusal', () => {
  const text =
    'atc/3.1.1+abc speaks protocol v7, daemon atc/legacy-build speaks v6; restart the daemon so both run the same build';

  expect(parseMismatchBuild(text)).toStrictEqual({ build: 'atc/legacy-build', protocol: 6 });
});

test('it reads null for a refusal in other words', () => {
  expect(parseMismatchBuild('protocol mismatch')).toBeNull();
});
