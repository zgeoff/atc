// A group already empty has nothing left to kill.
export function killProcessGroup(group: number): void {
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && Reflect.get(error, 'code') === 'ESRCH')) {
      throw error;
    }
  }
}
