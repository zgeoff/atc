import { expect, test } from 'bun:test';
import { isPublicAddress } from './is-public-address';

test.each([['104.18.32.47'], ['8.8.8.8'], ['2606:4700::6810:202f']])(
  'it treats %p as public',
  (address) => {
    expect(isPublicAddress(address)).toBeTrue();
  },
);

test.each([
  ['127.0.0.1'],
  ['10.1.2.3'],
  ['172.20.0.1'],
  ['192.168.1.10'],
  ['169.254.169.254'],
  ['100.100.1.2'],
  ['0.0.0.0'],
  ['224.0.0.1'],
  ['::1'],
  ['::'],
  ['fd7a:115c:a1e0::1'],
  ['fe80::1'],
  ['::ffff:127.0.0.1'],
  ['not-an-address'],
])('it treats %p as not public', (address) => {
  expect(isPublicAddress(address)).toBeFalse();
});
