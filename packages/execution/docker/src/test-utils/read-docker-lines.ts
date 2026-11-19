import { runDocker } from './run-docker';

export async function readDockerLines(...args: string[]): Promise<string[]> {
  const output = await runDocker(...args);

  return output.split('\n').filter((line) => line !== '');
}
