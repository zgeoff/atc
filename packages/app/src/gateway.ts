// Keep this import first: mcp-auth's own import of it loads too late in a compiled binary.
import 'reflect-metadata';
import { runGatewayCLI } from './run-gateway-cli';

// atc-gateway entry: serves the MCP tools over HTTP for the daemons a
// registry lists, and manages the clients that may connect to it. It loads
// nothing that starts a daemon or a session on this machine.
await runGatewayCLI(process.argv.slice(2), process.env);
