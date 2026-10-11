# Installing atc

atc ships as a prebuilt binary for macOS and Linux, on arm64 and x64, and as an npm package. It
needs at least one of the `claude`, `grok` or `codex` CLIs on your `PATH`.

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

With [Bun](https://bun.sh):

```bash
bun add -g @zgeoff/atc
```

## Environment

atc takes its environment from the process that starts it: a shell, a systemd unit or an MCP client
entry. A release binary never reads a `.env` file, so a line in `~/.env` reaches neither the daemon
nor the sessions it starts. Start the daemon from an environment that exports what your agents need,
since every local session inherits the daemon's environment.
