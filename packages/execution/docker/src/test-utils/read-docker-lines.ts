import { runDocker } from './run-docker';

// Runs the docker CLI and returns the non-empty lines of its output.
export async function readDockerLines(...args: string[]): Promise<string[]> {
  const output = await runDocker(...args);

  return output.split('\n').filter((line) => line !== '');
}
