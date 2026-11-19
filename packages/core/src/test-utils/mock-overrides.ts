import type { PartialDeep } from 'type-fest';

export type MockOverrides<T, K extends keyof T> = {
  readonly [P in K]?: PartialDeep<T[P]>;
} & {
  readonly [P in Exclude<keyof T, K>]?: T[P];
};
