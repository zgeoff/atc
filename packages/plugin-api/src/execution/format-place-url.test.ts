import { expect, test } from 'bun:test';
import { formatPlaceURL } from './format-place-url';

test.each([
  ['https://svc.example.dev/', 'https://svc.example.dev'],
  ['https://SVC.example.dev', 'https://svc.example.dev'],
  ['HTTPS://Svc.Example.Dev:7070//', 'https://svc.example.dev:7070'],
  ['https://svc.example.dev/Base/Path/', 'https://svc.example.dev/Base/Path'],
  ['ssh://Deploy@Box.Example.Dev', 'ssh://Deploy@box.example.dev'],
  ['tcp://10.0.0.4:2375/', 'tcp://10.0.0.4:2375'],
  ['http://[::ABCD]:8080/', 'http://[::abcd]:8080'],
  ['https://svc.example.dev:443', 'https://svc.example.dev'],
  ['http://svc.example.dev:80', 'http://svc.example.dev'],
  ['https://svc.example.dev/?x=1', 'https://svc.example.dev?x=1'],
  ['https://svc.example.dev?x=1', 'https://svc.example.dev?x=1'],
  ['https://svc.example.dev/#', 'https://svc.example.dev'],
  ['https://svc.example.dev/api/#', 'https://svc.example.dev/api'],
  ['https://svc.example.dev/#top', 'https://svc.example.dev#top'],
  ['https://svc.example.dev./', 'https://svc.example.dev'],
  ['  https://svc.example.dev ', 'https://svc.example.dev'],
  ['not a url', 'not a url'],
  ['svc.example.dev:443', 'svc.example.dev:443'],
])('it writes %s as %s', (url, expected) => {
  expect(formatPlaceURL(url)).toBe(expected);
});
