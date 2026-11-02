import { expect, test } from 'bun:test';
import { isPathWithin } from './is-path-within';

test.each([
  ['/srv/work/shop-main', '/srv/work/shop-main', true],
  ['/srv/work/shop-main/packages/api', '/srv/work/shop-main', true],
  ['/srv/work/shop-main-2', '/srv/work/shop-main', false],
  ['/srv/work', '/srv/work/shop-main', false],
  ['/srv/other', '/srv/work/shop-main', false],
])('it reads %s as within %s: %p', (child, parent, expected) => {
  expect(isPathWithin(child, parent)).toBe(expected);
});
