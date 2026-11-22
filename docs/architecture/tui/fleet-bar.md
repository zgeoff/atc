# The fleet bar

While a session is attached, the TUI draws the fleet bar on the last row of the terminal. The bar
groups the TUI's sessions by place, the machine or service a session runs on, which the daemon
reports for each session. For each place, the bar shows the place's label and a state glyph for each
of up to 4 of its sessions. At its right end, it shows how many sessions need the user, then the
leader key, the key that opens the session list. The TUI draws the bar itself, so it looks the same
under Claude Code, Codex and Grok.

```text
  laptop ◆ ⠋ ✓ ○ +1  docker ⠴  ink ◆ ⠸ ✓ ✓ +2                  ◆ 2 need you   ^Space
  └─ place label, in its colour  └─ glyphs: ◆ needs you · spinner running · ✓ done · ○ exited
```

[The place a session runs in](../daemon/sessions.md#the-place-a-session-runs-in) defines a place and
how the daemon builds its key. Several daemons can reach the same machine, so sessions from more
than one daemon can share a place. The bar is one layer of the [compositor](./compositor.md), which
owns the frame clock and the cell buffer.

## From sessions to the row

```mermaid
flowchart LR
  mirror["the TUI's copy of each daemon's sessions"] --> build[buildFleetBar]
  links["the TUI's daemon connections"] -->|"daemons that are down"| build
  build -->|"places, counts, detail level"| format[formatFleetBar]
  format -->|"cells"| layer[bar layer]
  clock[frame clock] -->|"10 frames a second while a session is running"| layer
  layer --> buffer["cell buffer, last row"]
```

The bar layer builds the bar again on each frame, so the bar keeps no state of its own. The TUI asks
the frame clock for a frame on each daemon event, so a change to the fleet, such as a session that
changes state, redraws the bar.

## Places in the TUI

The TUI reads each session's place, a `key` and a `label`, from the session's descriptor in the
daemon's listing. `pickPlaceColour` picks a place's colour from its key alone, so a place has the
same colour on every daemon that sends its key, and in every run.

A daemon older than the place field sends no `place`. For its sessions the TUI uses the key
`daemon:<daemon name>:<target id>` and the label `<target id>`, where the target id names the
execution target in the daemon's config that runs the session. The daemon on the TUI's own computer
has no name in the config, and the TUI writes its name as `local`. This fallback key differs from
the [place key](../daemon/sessions.md#the-place-a-session-runs-in) that a current daemon sends, so a
place's colour changes when its daemon is updated.

`pickPlaceLabels` gives one label to each place key:

- When the daemons in one place give it different labels, the TUI uses the label from the daemon on
  its own computer, else the label from the daemon listed first in the config's `daemons`.
- When two places share a label, the TUI appends parts to both labels, one part per round, until the
  labels differ: the daemon name, then the target id, then the place key. After three rounds a label
  reads `<label> · <daemon name> · <target id> · <place key>`. The TUI skips a part that equals the
  label.
- When a label with parts appended matches another place's plain label, the TUI appends the next
  part to both.

## Layout

The bar has a left part, which holds the places, and a right part, which holds the need-you count
and the leader key's label. The TUI lays out the right part first, and gives the left part the width
that is left.

- The bar keeps two blank columns at the left edge of the terminal and two at the right edge, the
  width of the margin that Claude Code's own status line keeps on the left. The bar never writes in
  these edge columns.
- The attached session's place comes first, then the other places in label order.
- Inside a place, one space separates the label and each glyph, as in `local ◆ ⠿ ⠿`. Two spaces
  separate one place from the next.
- The bar keeps 3 columns between the left part and the right part.
- The bar paints no background.

A session's glyph follows its state: `◆` for `needs_you`, a braille spinner for `running`, `✓` for
`done`, `○` for `exited` and `?` for a state that a newer daemon added and this TUI doesn't know.
Glyphs sort in that order, so a `◆` goes into the `+<n>` count only when a place has more than 4
sessions in `needs_you`.

The left part uses the most detailed level that fits its width:

| Level    | Each place shows                                                     |
| -------- | -------------------------------------------------------------------- |
| `glyphs` | its label, up to 4 glyphs, and `+<n>` for the rest                   |
| `counts` | its label, its session count, and `◆` when a session in it needs you |
| `short`  | as `counts`, with the label cut to 3 columns                         |

When `short` leaves no room for every place, the bar drops places from the end of the order, and
writes `…` after the last place it kept. When no place fits, the bar writes no `…`.

The right part shows the need-you count, `◆ <k> need you` in amber, then the leader key's label in
bold blue. `k` is the number of sessions in `needs_you` across every place, the dropped places
included. When `k` is 0, the right part shows only the leader key's label. Under 90 columns the
count shows as `◆ <k>`, without the words. When the right part doesn't fit between the edge columns,
the bar drops the leader key's label first, then the need-you count.

The bar measures each grapheme's width in terminal columns, so a wide character such as `界` takes
two columns.

## A daemon that is down

The TUI treats a daemon as down while its connection is lost, while the daemon refuses the TUI's
token, or while the daemon speaks another major protocol version. While a daemon is down, the TUI
keeps that daemon's sessions as they were last listed.

- When a place holds a session from a down daemon, the bar draws every glyph of that place in dim
  grey, the glyphs of its other daemons' sessions included, and puts `?` after its label. Next to a
  label, `?` marks a down daemon; among the glyphs, it marks an unknown state.
- The sessions of a down daemon still count toward the need-you count `k`.

## When the bar shows

The bar shows while a session is attached, including while the session list is open over it. Home,
the screen with no session attached, has no fleet bar.

While the TUI shows a notice, such as a failed call, the advice to update a daemon, or a lost
connection, the TUI draws the notice on the last row. The bar layer then draws nothing, so the
notice layer below it shows through, and the bar draws again once the notice clears.

While any session of any connected daemon is in the `running` state, the spinner turns 10 times a
second. The spinner turns even with the config's `animations` off. The bar layer asks the frame
clock for frames only while the bar shows and a session is `running`.

## Claude Code's status line

atc keeps the fleet's state out of Claude Code's own status line: the generated `--settings` file
runs atc's statusline reporter, which prints only the output of the status line command the user
configured for Claude Code. [Agent integration](../agents/agent-integration.md) describes the
reporter and the settings file.
