import { runGatewayCLI } from './gateway/run-gateway-cli';

// This entry loads nothing that starts a daemon or a session on this machine; it only serves
// the daemons a registry lists.
await runGatewayCLI(process.argv.slice(2), process.env);
