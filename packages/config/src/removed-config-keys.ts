/**
 * The config.json keys atc once read and no longer does. A file that still
 * sets one loads with a warning, and `atc config migrate` drops it.
 */
export const REMOVED_CONFIG_KEYS: readonly string[] = ['resumeInterruptedTurns'];
