# The session list

The leader key, `ctrl+space` unless the config's `leader` sets another, opens the session list: a
see-through panel over home, the screen with no session attached, or over the attached session. The
panel is a layer of the [compositor](./compositor.md). It writes its cells into the cell buffer,
blends them over the layers below, and dims those layers. It never draws through the screen
emulator, which the TUI's other screens share, so the session behind the panel keeps drawing while
the list is open.

## The attachment outlives the list

The client keeps the session attached while the list is open. The client tracks the attached session
apart from the row the user selects in the list, so the session keeps streaming output and taking
resizes behind the panel.

The attachment ends in three cases:

- The user goes home with `i`.
- The user quits.
- The user attaches a different session. The client detaches the old session first, so the daemon
  sizes the old session's PTY for the clients that stay attached to it.

When the attached session leaves the fleet while the list is open, the client goes home.

Enter on the row of the attached session closes the list and sends the daemon a new attach. The
daemon marks a session read, and clears its `needs_you` state, each time it receives an attach. The
client keeps the session's stream as it is. When the user closes the list without Enter, the client
sends an attach only if it lost the attachment, for example across a daemon reconnect.

## Rows and grouping

The client keeps a copy of every daemon's fleet, and the list builds its rows from that copy. `g`
cycles three groupings: flat, by repository, and by place, the machine a session runs on. The
config's `list.grouping` sets the grouping the list opens with. In both grouped modes, the pinned
sessions of every daemon form one group at the top.

The selection belongs to a session, so it stays on that session when a state change moves the
session to another row. The list keys each row by its daemon and its session id, because two daemons
can each hold a session with the same id.

The list shows the daemon column only when the fleet spans more than one daemon, and never in place
mode. In place mode the group header names the place, and a row in a group that mixes daemons shows
`via <daemon>` in the place column. When the terminal is narrower than 90 columns, the list shows
only the state glyph, the name, the message and the age of each row.

## Jump mode

`f` labels each visible row with a letter, which the user types to pick the row. The labels take the
keyboard's home row first (`asdfghjkl`), then the other letters. The user can also type part of a
name to narrow the rows, so a label never uses a letter that would extend the user's search:

- With nothing typed, a label uses no letter that appears in a visible name.
- After the user types text, a label uses no letter that follows the typed text in a visible name.

When single letters run out, the labels take two letters. A label on a live session attaches it. A
label on an exited session selects its row and attaches nothing.

## Ending a session

`X` ends a session: the daemon stops the agent and removes the session from the fleet. The TUI sends
`session.forget` with `refusePinned` set and without `refuseLive`, so the daemon stops a live
session before it removes it.

When the session's target would delete the machine the session runs on, the daemon answers the first
`session.forget` with a confirm token in place of ending the session. What the TUI does next depends
on the prompt the user answered:

- When the prompt named the machine, because the descriptor's `canDestroyHost` was true, the TUI
  sends `session.forget` again at once with the token.
- Otherwise the TUI shows a second prompt that names the machine, and sends the token only after the
  user answers `y`.

`K` kills a live session: the agent stops, and the session stays in the list as exited.

A prompt for `X` or `K` takes the panel's last line until the user answers. `y` confirms, and any
other key cancels. The leader key cancels the prompt and closes the list.

## The last line

The panel's last line shows the key bar, unless one of these needs the line. When several do, the
first in this list wins:

1. a prompt;
2. the filter the user is typing, or `no match` when jump mode has narrowed the rows to none;
3. a notice, such as the result of an action;
4. a line for each daemon that is down;
5. the advice to update a daemon that runs an older build.

A prompt wraps over as many lines as it needs, so the user always sees the action, what it deletes
and the keys that confirm it. The list cuts every other text to one line.

## Motion

The panel fades in, and the rows fade in one after another, each starting a fixed step after the row
above it. The close is a shorter fade when the list closes back to a session or to home. When a
screen such as the spawn picker replaces the list, the list closes at once. With the config's
`animations` off, the panel opens and closes in one frame. The durations are constants in
`packages/tui/src/session-list/constants.ts`.

While a fade runs, the panel asks the [frame clock](./compositor.md) for a frame at the clock's
frame interval. While a row shows a running session, the panel asks for a frame each time the row's
spinner turns, at the fleet bar's spinner rate. With no fade and no running session, the panel asks
for no frame. After the close fade ends, the panel asks for one more frame, which draws the screen
without it, so a late tick never leaves a faint panel on the screen.
