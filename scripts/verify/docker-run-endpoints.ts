import { z } from 'zod';

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
