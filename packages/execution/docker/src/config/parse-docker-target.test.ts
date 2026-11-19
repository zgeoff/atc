import { expect, test } from 'bun:test';
import { parseDockerTarget } from './parse-docker-target';

test('#parseDockerTarget lays each default in around the image', () => {
  expect(parseDockerTarget('box', { image: 'example/agents:1.4.0' })).toStrictEqual({
    kind: 'parsed',
    target: {
      image: 'example/agents:1.4.0',
      socket: '/var/run/docker.sock',
      namePrefix: 'atc-',
      signInVolume: 'atc-sign-in',
      guestDir: '/atc',
    },
  });
});

test('#parseDockerTarget derives the sign-in volume from the name prefix', () => {
  const parsed = parseDockerTarget('box', { image: 'example/agents', namePrefix: 'lab-' });

  expect(parsed).toStrictEqual({
    kind: 'parsed',
    target: expect.objectContaining({ signInVolume: 'lab-sign-in' }),
  });
});

test.each([
  ['image is missing', {}, 'image'],
  ['socket is relative', { image: 'a', socket: 'docker.sock' }, 'socket'],
  ['namePrefix starts with a hyphen', { image: 'a', namePrefix: '-x' }, 'namePrefix'],
  ['signInVolume holds a slash', { image: 'a', signInVolume: 'a/b' }, 'signInVolume'],
  ['guestDir ends in a slash', { image: 'a', guestDir: '/atc/' }, 'guestDir'],
  ['guestDir is relative', { image: 'a', guestDir: 'atc' }, 'guestDir'],
])('#parseDockerTarget refuses a target whose %s', (_label, options, key) => {
  const parsed = parseDockerTarget('box', options);

  expect(parsed).toStrictEqual({ kind: 'refused', problem: expect.stringContaining(key) });
});
