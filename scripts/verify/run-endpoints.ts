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
});

export type RunEndpoints = z.infer<typeof runEndpointsSchema>;

export function parseRunEndpoints(value: unknown): RunEndpoints {
  return runEndpointsSchema.parse(value);
}
