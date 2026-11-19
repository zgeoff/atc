import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTestCleanup } from '@atc/core/test-utils/register-test-cleanup';

interface StubSystemd {
  // The directory that holds the stand-in `systemctl` and `systemd-run`, to put
  // first on the PATH of every process that could reach a real one.
  readonly binDir: string;

  // The stand-in for /proc that `ATC_PROC_ROOT` points at; the pid cgroup files are written here.
  readonly procRoot: string;

  readonly readSystemctlCalls: () => string[];

  readonly readSystemdRunCalls: () => string[];

  readonly writeMainPID: (pid: number) => void;

  // Makes the pid's cgroup read as that of a service with this name
  // run by a user's systemd manager.
  readonly writeUnitCgroup: (pid: number, unit: string) => void;

  readonly writeBoundBy: (units: readonly string[]) => void;

  readonly remove: () => void;
}

// A real systemd-run --scope keeps the caller's environment, terminal and pid,
// so the stub execs a --scope command in place instead of starting it in the background.
export function createStubSystemd(atcCommand: readonly string[]): StubSystemd {
  const root = mkdtempSync(join(tmpdir(), 'atc-stub-systemd-'));

  const remove = registerTestCleanup(() => {
    rmSync(root, { recursive: true, force: true });
  });

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
  *"show --property=BoundBy"*)
    if [ -f "${root}/boundby" ]; then cat "${root}/boundby"; fi
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
# Stands in for a systemd-run linked against libsystemd-shared-261.so.
echo "$*" >> "${root}/systemd-run.log"
case " $* " in
  *" --scope "*)
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    shift
    exec "$@"
    ;;
esac
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
    writeUnitCgroup: (pid, unit) => {
      mkdirSync(join(procRoot, String(pid)), { recursive: true });

      writeFileSync(
        join(procRoot, String(pid), 'cgroup'),
        `0::/user.slice/user-${process.getuid?.() ?? 0}.slice/user@${process.getuid?.() ?? 0}.service/app.slice/${unit}\n`,
      );
    },
    writeBoundBy: (units) => {
      writeFileSync(join(root, 'boundby'), `${units.join(' ')}\n`);
    },
    remove,
  };
}
