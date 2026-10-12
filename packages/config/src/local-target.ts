/**
 * The daemon's own machine as a target: what a config that sets no targets
 * holds, the default of a targets map that holds it without a
 * `defaultTarget`, and where a fleet row that names no target ran.
 */
export const LOCAL_TARGET = { id: 'local', provider: 'local-pty', options: {} } as const;
