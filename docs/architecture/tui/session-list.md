# The session list

The session list is a panel that the user opens with the leader key, `ctrl+space` unless the
config's `leader` sets another. The panel opens over the attached session. With no session attached,
it opens over [home](./home.md), the screen that shows the atc wordmark and the fleet's counts.

The panel is a layer of the [compositor](./compositor.md). It writes its cells into the compositor's
cell buffer over the layers below, and dims those layers. The TUI's other screens, such as help and
the spawn picker, draw into the screen emulator, which covers the whole terminal and hides the
session while a screen uses it. The panel never draws there, so the session behind the panel keeps
drawing while the list is open.

## The attachment outlives the list

The client keeps the session attached while the list is open. The client tracks the attached session
apart from the row the user selects in the list, so the session keeps streaming output and taking
resizes behind the panel.

The user ends the attachment by:

- going home with `i`;
- quitting;
- attaching a different session. The client detaches the old session first. The daemon sizes a
  session's PTY for the clients attached to it, so the old session then takes the size of the
  clients that stay.

The attachment also ends when the daemon removes the attached session, for example because another
client ended it, or when the session's agent stops, for example on `K`. In both cases, the client
goes home and the list stays open over home. Home is the layer under the panel whenever no live
session shows, so the panel never sits over a blank screen.

Enter on the row of the attached session closes the list and sends the daemon a new attach, to mark
the session read. The daemon marks a session read each time it receives an attach, and that clears
the `needs_you` state, the state of a session whose agent waits for the user. An attach is the only
way to mark a session read. The client keeps the session's stream running through this attach, with
no replay of the screen.

A daemon reconnect can drop the attachment while the list is open. When the user closes the list
without Enter, the client sends an attach only if the attachment was dropped.

## Rows and grouping

The client keeps a copy of the sessions of every daemon it connects to, and the list builds its rows
from that copy. One row shows, from left to right:

- the state glyph;
- the name;
- the daemon;
- the place, which is the machine or service the session runs on;
- the repository;
- the agent;
- the message, which is the last status the agent reported;
- the age, which is the time since the client saw the session enter its state.

`g` cycles three groupings: `flat`, `repo` (by repository) and `place`. The config's `list.grouping`
sets the grouping the list opens with. `p` pins a session, which keeps `X` from ending it. In the
`repo` and `place` groupings, the pinned sessions of every daemon form one group at the top.

Each sub-session, a session that another session spawned, lists under its parent, at any depth, in
the group of the session at the top of its parent chain. A session whose parent chain loops back to
it lists at the top level, so every session lists once.

The selection belongs to a session, so it stays on that session when a state change moves the
session to another row. A key press acts on the selected session even when a change in the sessions
moved its row before the next frame. The list tells rows apart by daemon and session id together,
because two daemons can each hold a session with the same id.

The list hides the daemon column and the place column when that column would read the same on every
session row the filter leaves, scrolled-out rows included and a blank cell counted as a value. The
list decides each column apart from the other. When your fleet runs on one daemon and one place, the
list shows neither column, and as you type a filter, the list can hide or show a column. The
grouping and the terminal's width change the columns too:

- The daemon column holds the daemon that serves the session. The list never shows it in the `place`
  grouping.
- The place column holds the place's label. In the `place` grouping, the group header names the
  place, and the column holds `via <daemon>` for each session in a place that sessions reach through
  more than one daemon, and a blank cell for the rest.
- The `repo` grouping drops the repository column.
- When the terminal is narrower than 90 columns, a row shows only the state glyph, the name, the
  message and the age, whatever the rows hold.

The age stays blank for a `running` session. The client takes the age from `stateSince`, the time it
saw the session enter its state, and keeps that time across a reconnect to the daemon. A session
that was already in its state at the client's first listing has no `stateSince`, so its age stays
blank until its state next changes.

Inside a group, sessions sort by state in the order `needs_you`, `done`, `running`, `exited`,
`unknown`, then by the most recent attach. The groups take the order of their first sessions under
the same rule, and groups whose first sessions tie sort by label. When two groups in the `repo`
grouping would share a label, the client adds the daemon name to each, then parent folders, until
every label differs.

## Filtering

`/` starts a filter. The client keeps a row when the typed text fuzzy-matches the session's name
followed by its working folder, and hides the rest. Esc clears the filter.

## Jump mode

`f` starts jump mode, which picks one row by the letters the user sees in its name. Pressing `f`
changes nothing on screen. The user looks at the name they want and types a letter they can see in
it.

A typed letter matches anywhere in a session's name, with case ignored, and each further letter
narrows the match the way a search does: `t`, then `u`, keeps the names that hold `tu`. Rows that
match stay lit. Rows with no match fade, in the same way the panel fades the screen behind it. The
matched letters show in blue. When no row matches, the last line reads `no match`, and Backspace
takes the last typed letter back.

When several rows match, each gets a label: one amber letter written over the letter right after its
first match. With `t` typed, `tui-beautiful` shows as `tai-beautiful`, so the user presses `a`. A
name that holds the match more than once gets one label, at its first match. A match that ends the
name has no letter to write over, so its label sits right after the name. While letters are typed,
the list scrolls so that it shows the first lit row. Only a lit row that the list shows gets a
label. A lit row below the last shown row gets none until more letters narrow the rows.

Typing a label acts as Enter on its row: on a live session it attaches the session, and on an exited
session it selects the row and attaches nothing. When one row matches, the client acts on it at once
in the same way, with no label, whether or not the list shows its row. Esc leaves jump mode and
keeps the list open.

The client picks label letters so that a label never clashes with typing one more letter of a name.
A letter is free when it never follows a match in any lit row, counting every match in a name.
Labels use only free letters, in this order:

1. A shown lit row that no further letter can single out gets a free letter first. Two such rows are
   a name and a longer name that starts with it, such as `ab` among `aba` and `abb` once `ab` is
   typed, and two rows with the same name.
2. The other shown lit rows take the free letters that are left. When those run out, the remaining
   rows show no label, and the user types more letters of the name to narrow the rows.
3. When the rows in step 1 outnumber the free letters, every shown lit row gets a two-letter label,
   drawn over the two letters after its match. The user types both letters.

## Ending and killing a session

`X` ends a session: the daemon stops the agent and removes the session from the fleet. When the
session is pinned, the client shows a notice to unpin it first and asks nothing. Otherwise the
client shows a prompt on the panel's last line, and sends nothing until the user answers `y`.

Some [execution targets](../execution/targets.md) give each session a machine of its own, and ending
the session deletes that machine. An imp, a cloud machine that atc starts for a session, is one. The
session's descriptor, the record the daemon sends for each session, holds `canDestroyHost: true` for
such a session, and then the client's prompt names the machine.

After `y`, the client sends `session.forget` with `refusePinned` set and without `refuseLive`, so
the daemon stops a live session before it removes it. For a session with a machine of its own, the
daemon answers the first `session.forget` with a confirm token in place of ending it:

- When the client's prompt named the machine, the client sends `session.forget` again at once with
  the token.
- Otherwise the client shows a second prompt that names the machine, and sends the token only after
  the user answers `y`.

A sub-session on its parent's machine has no machine of its own to delete, so the daemon ends it on
the first `session.forget`. The daemon also removes the session's exited, unpinned sub-sessions, and
the client puts their count in the prompt. The client can't see which execution target each
sub-session runs on. Some targets keep an exited sub-session, so the count can include one the
daemon keeps, but it never misses one the daemon removes.

When the session's machine is asleep, the daemon refuses with `host_asleep`, and the client shows a
notice that tells the user to attach to wake the machine, then end the session.

The daemon can keep the session's workspace folder, the folder it cloned for the session, for
example when the folder holds uncommitted work. The list then shows a notice that names the folder
and the daemon's reasons. When the ended session was the attached one, the client goes home and
shows the notice on home. The next opening of the list drops that notice.

`K` kills a live session after a prompt: the agent stops, and the session stays in the list as
exited. On an exited session `K` does nothing, and the key bar on the panel's
[last line](#the-last-line) shows `X end` in its place. `X` is the only key that deletes a machine.

While a prompt for `X` or `K` is open, `y` confirms it, and any other key cancels it. The leader key
cancels the prompt and closes the list. When the session leaves the fleet while its prompt is open,
the client drops the prompt, and the next key acts on the list.

## Keys that arrive together

The terminal can deliver several keys in one input chunk, such as letters typed fast. The client
applies them one at a time, so a key that changes the mode hands the keys after it to the new mode.
A leader that shares a chunk with typing for the attached session opens the list, and the list takes
the keys after it. A leader byte inside a bracketed paste stays text for the session.

## The last line

The panel's last line shows the key bar, unless one of these needs it. When several do, the first in
this list wins:

1. a prompt;
2. the filter text the user is typing, or `no match` when the letters typed in jump mode match no
   row;
3. a notice, such as the result of an action;
4. the daemons that are down, all on one line;
5. the advice to update a daemon that runs an older build.

A prompt grows upward from the last line over as many lines as it needs, so the user always sees the
action, what it deletes and the keys that confirm it. The list cuts every other text to one line. In
a window too short for the whole panel, the client drops list rows first, then the borders, and a
prompt taller than the window keeps its last lines, which hold the keys.

## Fill and dimming

The panel dims the screen behind it, apart from the terminal's last row, so the
[fleet bar](./fleet-bar.md) stays readable. Inside its border, the panel covers what lies behind it.
Each of its cells takes the terminal's default background, apart from the tint on the selected row.

## Motion

The panel fades in, and the rows fade in one after another, each starting a step after the row above
it. The whole open, the last row included, ends within a fixed time whatever the row count, so the
step shrinks as the list grows, and a short list keeps a visible stagger. The close is a shorter
fade when the list closes back to a session or to home. When a screen such as the spawn picker
replaces the list, the list closes at once. A close that starts during the open fade, or an open
that starts during the close fade, starts from the levels the other fade had reached, so the panel
never jumps. With the config's `animations` off, the panel opens and closes in one frame. The
durations are constants in [`constants.ts`](../../../packages/tui/src/session-list/constants.ts).

The panel lays itself out again on each frame while it is open. While it fades out, the list's state
can be gone, so the panel keeps the rows and text it last drew, and lays those out again when the
terminal's size changes.

The panel asks the [frame clock](./compositor.md) for frames only while something on it moves:

- While a fade runs, it asks for a frame at the clock's frame interval.
- While a row shows a running session, it asks for a frame each time the row's spinner turns, at the
  spinner rate of the [fleet bar](./fleet-bar.md).
- While rows show an age, it asks for a frame at the soonest moment any shown age changes: each
  second, then each minute, hour or day, as the age's unit grows.

With no fade, no running session and no age, the panel asks for no frame. The clock skips a tick
that runs late, so the last tick of a close fade can be skipped. After the close fade ends, the
panel therefore asks for one more frame, which draws the screen without the panel, so no faint panel
stays on the screen.
