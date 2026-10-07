import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface StubSystemd {
  // The directory that holds the stand-in `systemctl` and `systemd-run`, to put
  // first on the PATH of every process that could reach a real one.
  readonly binDir: string;

  // The directory `ATC_PROC_ROOT` points at, where `placeInUnit` writes.
  readonly procRoot: string;

  // The arguments of every `systemctl` call, one line per call.
  readonly readSystemctlCalls: () => string[];

  // The arguments of every `systemd-run` call, one line per call.
  readonly readSystemdRunCalls: () => string[];

  // Makes `systemctl show -p MainPID` print this pid.
  readonly writeMainPID: (pid: number) => void;

  // Places the pid in a user service of the given name, as the cgroup of a
  // daemon run by a user manager reads.
  readonly placeInUnit: (pid: number, unit: string) => void;

  readonly [Symbol.dispose]: () => void;
}

/**
 * Writes a stand-in `systemctl` and `systemd-run` that touch no service
 * manager. Without a MainPID, `systemctl show -p MainPID` prints a pid no
 * process holds, so no daemon is ever a unit's main process. With
 * `writeMainPID`, `systemctl restart` stops that pid with SIGTERM and starts
 * `atcCommand daemon` in the background. `systemd-run` runs the command after
 * `--` in the background with only the `--setenv` variables, as a transient
 * unit sees them, and appends its output to the `StandardOutput=append:`
 * file. Every call is logged.
 */
export function createStubSystemd(atcCommand: readonly string[]): StubSystemd {
  const root = mkdtempSync(join(tmpdir(), 'atc-stub-systemd-'));
  const binDir = join(root, 'bin');
  const procRoot = join(root, 'proc');
  const atcLine = atcCommand.map((part) => `"${part}"`).join(' ');

  mkdirSync(binDir);
  mkdirSync(procRoot);

  writeFileSync(
    join(binDir, 'systemctl'),
    `#!/usr/bin/env bash
echo "$*" >> "${root}/systemctl.log"
case "$*" in
  *"show -p MainPID"*)
    if [ -f "${root}/mainpid" ]; then cat "${root}/mainpid"; else echo 999999; fi
    ;;
  *"show -p ExecStart"*)
    echo "{ path=/fake/bin/atc ; argv[]=/fake/bin/atc daemon ; }"
    ;;
  *"restart "*)
    if [ -f "${root}/mainpid" ]; then
      pid="$(cat "${root}/mainpid")"
      kill "$pid" 2>/dev/null
      for _ in $(seq 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
      ${atcLine} daemon > /dev/null 2>&1 < /dev/null &
    fi
    ;;
esac
exit 0
`,
  );

  writeFileSync(
    join(binDir, 'systemd-run'),
    `#!/usr/bin/env bash
echo "$*" >> "${root}/systemd-run.log"
envargs=()
log=/dev/null
while [ $# -gt 0 ]; do
  case "$1" in
    --setenv=*) envargs+=("\${1#--setenv=}"); shift ;;
    --property=StandardOutput=append:*) log="\${1#--property=StandardOutput=append:}"; shift ;;
    --unit) shift 2 ;;
    --) shift; break ;;
    *) shift ;;
  esac
done
env -i "\${envargs[@]}" "$@" >> "$log" 2>&1 < /dev/null &
exit 0
`,
  );

  chmodSync(join(binDir, 'systemctl'), 0o755);
  chmodSync(join(binDir, 'systemd-run'), 0o755);

  const readLines = (name: string) => {
    try {
      return readFileSync(join(root, name), 'utf8')
        .split('\n')
        .filter((line) => line !== '');
    } catch {
      return [];
    }
  };

  return {
    binDir,
    procRoot,
    readSystemctlCalls: () => readLines('systemctl.log'),
    readSystemdRunCalls: () => readLines('systemd-run.log'),
    writeMainPID: (pid) => {
      writeFileSync(join(root, 'mainpid'), String(pid));
    },
    placeInUnit: (pid, unit) => {
      mkdirSync(join(procRoot, String(pid)), { recursive: true });

      writeFileSync(
        join(procRoot, String(pid), 'cgroup'),
        `0::/user.slice/user-${process.getuid?.() ?? 0}.slice/user@${process.getuid?.() ?? 0}.service/app.slice/${unit}\n`,
      );
    },
    [Symbol.dispose]: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
