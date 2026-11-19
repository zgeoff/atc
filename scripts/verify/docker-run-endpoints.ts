import { z } from 'zod';

// The ready line of the `docker` target's app: the run's folders, the daemon's socket and
// database, and the names of the docker objects the run made, which share one prefix.
const dockerRunEndpointsSchema = z.object({
  root: z.string().min(1),
  home: z.string().min(1),
  socket: z.string().min(1),
  db: z.string().min(1),
  prefix: z.string().min(1),
});

export type DockerRunEndpoints = z.infer<typeof dockerRunEndpointsSchema>;

export function parseDockerRunEndpoints(value: unknown): DockerRunEndpoints {
  return dockerRunEndpointsSchema.parse(value);
}
