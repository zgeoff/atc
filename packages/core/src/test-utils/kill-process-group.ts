// A group already empty has nothing left to kill. macOS refuses a signal to a group whose leader
// has exited with EPERM rather than ESRCH, so both mean the group is gone.
const goneCodes: ReadonlySet<unknown> = new Set(['ESRCH', 'EPERM']);

export function killProcessGroup(
  group: number,
  signalGroup: (target: number, signal: NodeJS.Signals) => void = (target, signal) => {
    process.kill(target, signal);
  },
): void {
  try {
    signalGroup(-group, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && goneCodes.has(Reflect.get(error, 'code')))) {
      throw error;
    }
  }
}
