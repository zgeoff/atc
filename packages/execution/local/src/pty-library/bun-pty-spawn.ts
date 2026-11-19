// bun-pty reads BUN_PTY_LIB as it loads. A bundle keeps no lazy load of it,
// and Bun's bundler skips a top-level await under a re-export, so an import
// that runs first puts the copy in place.
import './point-bun-pty-at-copy';
import { restorePTYLibraryEnv } from './expose-pty-library';

export { spawn as bunPTYSpawn } from 'bun-pty';
restorePTYLibraryEnv();
