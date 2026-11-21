# 0003: The TUI composites attached sessions

- Date: 2026-11-21
- Status: decided

## Decision

The TUI keeps a terminal emulator, `@xterm/headless`, for the session the user is attached to. The
TUI feeds the session's output into that emulator and draws the emulator's screen as the bottom
layer of each frame it writes to the user's terminal. The session's output never goes straight to
the user's terminal. The TUI passes on only the few escape sequences that
[the compositor design](../design/tui-redesign/compositor.md#sequences-from-the-session) lists, such
as the ones that set the clipboard or the window title.

## Why

[The TUI redesign](../design/tui-redesign/README.md) draws these layers over a live session:

- The session list opens over the session and dims it. To dim a cell, the TUI has to know the cell's
  character and colours, and the TUI knows them only if it keeps its own emulator of the session's
  screen.
- The fleet bar takes the terminal's last row. If the session's output went straight to the user's
  terminal, an agent that reset the scroll region or scrolled the whole screen would move or
  overwrite that row.

## Rejected alternatives

The daemon keeps an emulator of each session too, to answer `atc_terminal_read` and to replay the
screen when a client attaches.

| Option                                                                           | Why not                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| send the session's output straight through, and draw the list as an opaque panel | the TUI can't dim the session behind the list, and the agent's output can still overwrite the last row                                           |
| send the output straight through, and keep the last row out of a scroll region   | an agent that sets its own scroll region with `CSI r` (DECSTBM) replaces the TUI's region, and the last row scrolls with the rest                |
| draw each frame from the daemon's emulator                                       | the TUI would ask the daemon for the screen on every frame, a round trip per frame, and the screen would cross the network as well as the output |

## Consequences

- The daemon and the TUI each parse every byte an agent writes.
- A notice or a prompt that the TUI draws is one more layer, and an agent's output can't move or
  overwrite it.
- An image an agent draws with kitty graphics or sixel does not show, because `@xterm/headless` does
  not model images and the TUI does not pass those sequences on.
- The TUI copies the session's input modes, such as mouse tracking and bracketed paste, onto the
  user's terminal, and resets them on detach and exit.
- The TUI answers the queries an agent sends to its terminal, such as cursor position and background
  colour, because those queries never reach the user's terminal.
