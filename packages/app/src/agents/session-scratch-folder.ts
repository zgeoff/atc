/**
 * The folder inside a session's own folder that the session's CLI reads
 * and writes without a prompt and takes as its temporary folder, so a file
 * the agent leaves there for itself never sends a read outside the
 * working directories.
 */
export const SESSION_SCRATCH_FOLDER = 'scratch';
