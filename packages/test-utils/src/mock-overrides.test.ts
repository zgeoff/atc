import { expectTypeOf, test } from 'bun:test';
import type { MockOverrides } from './mock-overrides';

test('it takes a deep partial for a key the defaults set', () => {
  expectTypeOf({ auth: { profiles: ['glm'] } }).toExtend<
    MockOverrides<{ auth: { profiles: string[]; placeholderEnv: Record<string, string> } }, 'auth'>
  >();
});

test('it takes a whole value for a key the defaults leave out', () => {
  expectTypeOf({ auth: { profiles: ['glm'], placeholderEnv: {} } }).toExtend<
    MockOverrides<
      { id: string; auth?: { profiles: string[]; placeholderEnv: Record<string, string> } },
      'id'
    >
  >();
});

test('it refuses a partial value for a key the defaults leave out', () => {
  expectTypeOf({ auth: { profiles: ['glm'] } }).not.toExtend<
    MockOverrides<
      { id: string; auth?: { profiles: string[]; placeholderEnv: Record<string, string> } },
      'id'
    >
  >();
});
