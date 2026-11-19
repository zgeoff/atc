import { z } from 'zod';

const runEndpointsSchema = z.object({
  root: z.string().min(1),
  home: z.string().min(1),
  stub: z.string().min(1),
  config: z.string().min(1),
  socket: z.string().min(1),
  events: z.string().min(1),
  db: z.string().min(1),

  daemonLog: z.string().min(1),

  remote: z.url(),
  gateway: z.url(),
  gatewayWrong: z.url(),
});

export type RunEndpoints = z.infer<typeof runEndpointsSchema>;

export function parseRunEndpoints(value: unknown): RunEndpoints {
  return runEndpointsSchema.parse(value);
}
