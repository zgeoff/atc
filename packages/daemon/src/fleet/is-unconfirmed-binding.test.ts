import { expect, test } from 'bun:test';
import { isUnconfirmedBinding } from './is-unconfirmed-binding';

test.each([
  ['the kind and a bare digest', 'cloud:0123456789abcdef', true],
  ['the kind, the version, and a digest', 'cloud:reach-v2:0123456789abcdef', false],
  ['another kind and a bare digest', 'other:0123456789abcdef', false],
  ['a digest of fifteen digits', 'cloud:0123456789abcde', false],
  ['a digest with an upper-case digit', 'cloud:0123456789ABCDEF', false],
])(
  'it answers whether a binding of %s on a kind with a rule is unconfirmed',
  (_label, identity, expected) => {
    expect(
      isUnconfirmedBinding(
        {
          id: 'far',
          kind: 'cloud',
          options: {},
          identity: 'cloud:reach-v2:fedcba9876543210',
          identityRule: { version: 'reach-v2', ignoredOptions: [] },
          provider: null,
        },
        identity,
      ),
    ).toBe(expected);
  },
);

test('it never counts a binding unconfirmed on a kind whose plugin declares no rule', () => {
  expect(
    isUnconfirmedBinding(
      {
        id: 'far',
        kind: 'cloud',
        options: {},
        identity: 'cloud:fedcba9876543210',
        provider: null,
      },
      'cloud:0123456789abcdef',
    ),
  ).toBeFalse();
});
