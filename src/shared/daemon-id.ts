import type { Tagged } from 'type-fest';

/**
 * The id a daemon holds for its whole life, minted once into its state
 * store. It names the daemon in `daemon.hello`, in every session locator,
 * and in the ownership row of each session the daemon persists.
 */
export type DaemonID = Tagged<string, 'DaemonID'>;
