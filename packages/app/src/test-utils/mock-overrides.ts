import type { PartialDeep } from 'type-fest';

/**
 * The overrides a mock factory takes for a type whose defaults set the
 * keys `K`: a field the defaults set takes a deep partial, merged into the
 * default, and any other field takes a whole value, since there is no
 * default to merge a partial one into.
 */
export type MockOverrides<T, K extends keyof T> = {
  readonly [P in K]?: PartialDeep<T[P]>;
} & {
  readonly [P in Exclude<keyof T, K>]?: T[P];
};
