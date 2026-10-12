# Installing atc

atc ships as a prebuilt binary for macOS and Linux, on arm64 and x64. It needs at least one of the
`claude`, `grok` or `codex` CLIs on your `PATH`.

## Homebrew

```bash
brew install zgeoff/tap/atc
```

## The install script

```bash
curl -fsSL https://raw.githubusercontent.com/zgeoff/atc/main/install.sh | sh
```

The script puts `atc` in `~/.local/bin`. Set `ATC_INSTALL_DIR` to install somewhere else. The
checksums are on the [releases page](https://github.com/zgeoff/atc/releases).

## From npm

The `@zgeoff/atc` npm package is deprecated and gets no new releases. If you installed atc with
`bun add -g @zgeoff/atc`, remove it with `bun remove -g @zgeoff/atc` and install a binary instead.

## Environment

atc takes its environment from the process that starts it: a shell, a systemd unit or an MCP client
entry. A release binary never reads a `.env` file, so a line in `~/.env` reaches neither the daemon
nor the sessions it starts. Start the daemon from an environment that exports what your agents need,
since every local session inherits the daemon's environment.
