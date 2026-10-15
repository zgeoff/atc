import { expectTypeOf, test } from 'bun:test';
import type { ContextMemberScope } from './context-member-scopes';
import { CONTEXT_MEMBER_SCOPES } from './context-member-scopes';
import type { DaemonContext } from './daemon-context';

test('it states a scope for every member of the daemon context and no other key', () => {
  expectTypeOf<keyof typeof CONTEXT_MEMBER_SCOPES>().toEqualTypeOf<keyof DaemonContext>();
});

test('it fails to compile against a daemon context with a required member it gives no scope', () => {
  expectTypeOf(CONTEXT_MEMBER_SCOPES).not.toExtend<
    Record<keyof (DaemonContext & { readonly grantEverything: () => void }), ContextMemberScope>
  >();
});

test('it fails to compile against a daemon context with an optional member it gives no scope', () => {
  expectTypeOf(CONTEXT_MEMBER_SCOPES).not.toExtend<
    Record<keyof (DaemonContext & { readonly spareBytes?: number }), ContextMemberScope>
  >();
});
