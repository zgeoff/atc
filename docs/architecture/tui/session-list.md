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

When the attached session leaves the fleet while the list is open, the client goes home. When the
attached session dies while the list is open, for example on `K`, the panel stays open over home,
which the client draws under every opening of the list.

Enter on the row of the attached session closes the list and sends the daemon a new attach. The
daemon marks a session read, and clears its `needs_you` state, each time it receives an attach. The
client keeps the session's stream as it is. When the user closes the list without Enter, the client
sends an attach only if it lost the attachment, for example across a daemon reconnect.

## Rows and grouping

The client keeps a copy of every daemon's fleet, and the list builds its rows from that copy. `g`
cycles three groupings: flat, by repository, and by place, the machine a session runs on. The
config's `list.grouping` sets the grouping the list opens with. In both grouped modes, the pinned
sessions of every daemon form one group at the top. A sub-session lists under its parent, at any
depth, and in its family root's group. A session whose parent chain loops back to it lists at the
top level, so every session lists once.

The selection belongs to a session, so it stays on that session when a state change moves the
session to another row. A key acts on that session even when a fleet change moved its row before the
next frame. The list keys each row by its daemon and its session id, because two daemons can each
hold a session with the same id.

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

When single letters run out, the labels take two letters, each starting with a free letter. When
those run out too, the first letter of a label can be a letter that would extend the search, and
typing that letter then starts the label. A label on a live session attaches it. A label on an
exited session selects its row and attaches nothing.

## Ending a session

`X` ends a session: the daemon stops the agent and removes the session from the fleet. The TUI sends
`session.forget` with `refusePinned` set and without `refuseLive`, so the daemon stops a live
session before it removes it.

When the forget would delete the machine the session owns, the daemon answers the first
`session.forget` with a confirm token in place of ending the session. What the TUI does next depends
on the prompt the user answered:

- When the prompt named the machine, because the descriptor's `canDestroyHost` was true, the TUI
  sends `session.forget` again at once with the token.
- Otherwise the TUI shows a second prompt that names the machine, and sends the token only after the
  user answers `y`.

A sub-session on its parent's machine deletes no machine, so the daemon ends it on the first call.

When the forget keeps the session's workspace folder, the list shows a notice that names the folder
and the reasons. When the ended session was the attached one, the client goes home and shows the
notice on the status bar there. The next opening of the list drops that notice.

`K` kills a live session: the agent stops, and the session stays in the list as exited.

A prompt for `X` or `K` takes the panel's last line until the user answers. `y` confirms, and any
other key cancels. The leader key cancels the prompt and closes the list. When the session leaves
the fleet, the client drops its prompt, and the next key acts on the list.

The terminal can deliver several keys in one input chunk, such as letters typed fast. The client
applies them one at a time, so a key that changes the mode hands the keys after it to the new mode.
A leader that shares a chunk with the attached session's input opens the list, and the list takes
the keys after it. A leader byte inside a bracketed paste stays text for the session.

## The last line

The panel's last line shows the key bar, unless one of these needs the line. When several do, the
first in this list wins:

1. a prompt;
2. the filter the user is typing, or `no match` when jump mode has narrowed the rows to none;
3. a notice, such as the result of an action;
4. a line for each daemon that is down;
5. the advice to update a daemon that runs an older build.

A prompt wraps over as many lines as it needs, so the user always sees the action, what it deletes
and the keys that confirm it. The list cuts every other text to one line. In a window too short for
the whole panel, the last lines keep their rows before the list rows and the borders, and a prompt
taller than the window keeps its end, which holds the keys.

## Motion

The panel fades in, and the rows fade in one after another, each starting a fixed step after the row
above it. The close is a shorter fade when the list closes back to a session or to home. When a
screen such as the spawn picker replaces the list, the list closes at once. A close that starts
during the open fade, or an open that starts during the close fade, starts from the levels the other
fade had reached, so the panel never jumps. With the config's `animations` off, the panel opens and
closes in one frame. The durations are constants in `packages/tui/src/session-list/constants.ts`.

The panel lays itself out again on each frame of the open. While it fades out, it keeps the input it
last drew, since the list's state can be gone, and lays that input out again when the terminal's
size changes.

While a fade runs, the panel asks the [frame clock](./compositor.md) for a frame at the clock's
frame interval. While a row shows a running session, the panel asks for a frame each time the row's
spinner turns, at the fleet bar's spinner rate. While a shown row has an age, the panel asks for a
frame at the moment the first shown age next changes, which steps as the age does: each second, then
each minute, hour or day. With no fade, no running session and no age, the panel asks for no frame.
After the close fade ends, the panel asks for one more frame, which draws the screen without it, so
a late tick never leaves a faint panel on the screen.
