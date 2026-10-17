import type { PartialDeep } from 'type-fest';

// A field the defaults set takes a deep partial merged into its default; any
// other field takes a whole value, having no default to merge a partial into.
export type MockOverrides<T, K extends keyof T> = {
  readonly [P in K]?: PartialDeep<T[P]>;
} & {
  readonly [P in Exclude<keyof T, K>]?: T[P];
};
