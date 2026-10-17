// the CLI reads and writes here without a prompt and takes it as its temporary folder, so a
// file the agent leaves for itself never sends a read outside the working directories
export const SESSION_SCRATCH_FOLDER = 'scratch';
