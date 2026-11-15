import { z } from 'zod';

// The paths of one run, which the ready line of the `local` target's app prints, and which every
// driver config, action and check reads from the run's endpoints.
const runEndpointsSchema = z.object({
  root: z.string().min(1),
  home: z.string().min(1),
  stub: z.string().min(1),
  config: z.string().min(1),
  socket: z.string().min(1),
  events: z.string().min(1),
  db: z.string().min(1),

  // the daemon's stderr, where its TCP listener logs each refused handshake
  daemonLog: z.string().min(1),

  // the origins of `atc mcp --http`, the gateway that holds the daemon's token, and the gateway
  // that holds a wrong one; each origin is also its OAuth issuer
  remote: z.url(),
  gateway: z.url(),
  gatewayWrong: z.url(),
});

export type RunEndpoints = z.infer<typeof runEndpointsSchema>;

export function parseRunEndpoints(value: unknown): RunEndpoints {
  return runEndpointsSchema.parse(value);
}
