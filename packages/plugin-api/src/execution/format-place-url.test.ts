import { expect, test } from 'bun:test';
import { formatPlaceURL } from './format-place-url';

test.each([
  ['https://svc.example.dev/', 'https://svc.example.dev'],
  ['https://SVC.example.dev', 'https://svc.example.dev'],
  ['HTTPS://Svc.Example.Dev:7070//', 'https://svc.example.dev:7070'],
  ['https://svc.example.dev/Base/Path/', 'https://svc.example.dev/Base/Path'],
  ['ssh://Deploy@Box.Example.Dev', 'ssh://Deploy@box.example.dev'],
  ['tcp://10.0.0.4:2375/', 'tcp://10.0.0.4:2375'],
  ['not a url', 'not a url'],
])('it writes %s as %s', (url, expected) => {
  expect(formatPlaceURL(url)).toBe(expected);
});
