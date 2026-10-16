# Backing up and restoring the daemon

`atc backup` copies the running daemon's state database to a file you name, and you restore that
file by putting it in place of the database while no daemon runs. The database is `atc.db` in the
state directory, `~/.local/state/atc/`. It holds the fleet, the event trail, the inbox, the
idempotency keys and the daemon id, so a daemon that starts on a restored database lists every
session the backup held and restores them.

## Taking a backup

Run the command on the daemon's host while the daemon runs:

```bash
atc backup ~/backups/atc.db
```

The daemon writes the copy itself, as one SQLite snapshot, so the copy is consistent even while
sessions change during it. A relative path resolves against the directory you run the command in.
The daemon replaces a file already at the path only once the whole copy is on disk, so a backup that
fails leaves the earlier file in place. Only your user can read the copy. The daemon refuses a path
that is its own database or one of the database's log files, since replacing a file SQLite holds
open loses later writes.

On success the command prints `atc backup: wrote <bytes> bytes to <path>` and exits 0. It exits 1
with the reason on stderr when no daemon runs, since it never starts one, and when the running
daemon is older than the command. Restart such a daemon with `atc daemon restart` first.

The backup holds the database alone. These stay out of it:

- Agent transcripts, which each agent CLI writes where it keeps its sessions. A restored session
  resumes from its transcript, so a restore on another host needs those files too.
- `mcp-auth.db`, the OAuth state and passkeys of `atc mcp --http`, which the daemon never opens.
- `status.json` and `daemon.json`, which the daemon writes again when it starts.

## Restoring a backup

A restored daemon takes the daemon id the backup holds, so a gateway registry that lists the daemon
keeps matching it.

> **CAUTION:** Two daemons that run from copies of one backup share a daemon id, and each acts on
> the sessions and hosts the other owns. Restore a backup on one host only, and keep the daemon it
> came from stopped.

1. Stop the daemon. Under systemd, run:

   ```bash
   systemctl --user stop atc-daemon.service
   ```

   Without the unit, end the `atc daemon` process. Close every atc client first, since a client
   starts a daemon when none runs.

2. Remove the database and its write-ahead log files from the state directory:

   ```bash
   rm -f ~/.local/state/atc/atc.db ~/.local/state/atc/atc.db-wal ~/.local/state/atc/atc.db-shm
   ```

   > **CAUTION:** SQLite applies a leftover `atc.db-wal` file to whatever database sits beside it,
   > which corrupts the restored file. Remove both log files with the database.

3. Copy the backup into place:

   ```bash
   install -m 600 ~/backups/atc.db ~/.local/state/atc/atc.db
   ```

4. Start the daemon, with `systemctl --user start atc-daemon.service` or by opening `atc`.

The daemon restores the fleet by itself once it listens, unless `restoreFleetOnRestart` is `false`,
in which case `R` on the home screen restores it. Every session the backup held lists again under
its atc session id, and an exited session stays exited.
