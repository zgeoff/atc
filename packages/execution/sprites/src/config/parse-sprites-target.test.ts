import { expect, test } from 'bun:test';
import { parseSpritesTarget } from './parse-sprites-target';

test('it lays each default in for a target that sets only a token variable', () => {
  expect(parseSpritesTarget('box', { tokenEnv: 'SPRITES_TOKEN' })).toStrictEqual({
    kind: 'parsed',
    target: {
      token: { kind: 'env', name: 'SPRITES_TOKEN' },
      spritePrefix: 'atc-',
      apiURL: 'https://api.sprites.dev',
      guestDir: '/home/sprite/.atc',
    },
  });
});

test('it reads a token file with its own prefix, API and guest folder', () => {
  expect(
    parseSpritesTarget('box', {
      tokenFile: '/etc/sprites.token',
      spritePrefix: 'team-',
      apiURL: 'http://127.0.0.1:9000',
      guestDir: '/opt/atc',
    }),
  ).toStrictEqual({
    kind: 'parsed',
    target: {
      token: { kind: 'file', path: '/etc/sprites.token' },
      spritePrefix: 'team-',
      apiURL: 'http://127.0.0.1:9000',
      guestDir: '/opt/atc',
    },
  });
});

test.each([
  ['both token keys', { tokenEnv: 'A', tokenFile: '/a' }],
  ['neither token key', {}],
])('it refuses a target with %s', (_label, options) => {
  expect(parseSpritesTarget('box', options)).toStrictEqual({
    kind: 'refused',
    problem: 'target "box" must give exactly one of tokenEnv and tokenFile',
  });
});

test.each([
  ['an empty tokenEnv', { tokenEnv: '' }],
  ['a relative tokenFile', { tokenFile: 'token' }],
  ['an upper case prefix', { tokenEnv: 'A', spritePrefix: 'Atc-' }],
  ['an apiURL with a path', { tokenEnv: 'A', apiURL: 'https://api.example.com/v1' }],
  ['a guestDir with a trailing slash', { tokenEnv: 'A', guestDir: '/opt/atc/' }],
])('it refuses %s', (_label, options) => {
  expect(parseSpritesTarget('box', options).kind).toBe('refused');
});
