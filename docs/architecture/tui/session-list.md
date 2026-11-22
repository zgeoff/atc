# The session list

The session list is a panel that the user opens with the leader key, `ctrl+space` unless the
config's `leader` sets another. The panel opens over the attached session, or over home when no
session is attached.

The panel is a layer of the [compositor](./compositor.md). It writes its cells into the cell buffer
over the layers below, and dims those layers. The TUI's other screens, such as help and the spawn
picker, draw into the screen emulator, which covers the whole terminal and hides the session while a
screen uses it. The panel never draws there, so the session behind the panel keeps drawing while the
list is open.

## The attachment outlives the list

The client keeps the session attached while the list is open. The client tracks the attached session
apart from the row the user selects in the list, so the session keeps streaming output and taking
resizes behind the panel.

The attachment ends when:

- The user goes home with `i`.
- The user quits.
- The user attaches a different session. The client detaches the old session first. The daemon sizes
  a session's PTY for the clients attached to it, so the old session then takes the size of the
  clients that stay.

When the daemon removes the attached session while the list is open, for example because another
client ended it, the client goes home and the list stays open over home. When the attached session's
agent stops while the list is open, for example on `K`, the panel also stays open over home. The
[home layer](./home.md) is the layer under the panel whenever no live session shows, so the panel
never sits over a blank screen.

Enter on the row of the attached session closes the list and sends the daemon a new attach, because
the daemon marks a session read each time it receives an attach. A session the agent left waiting
for the user is in the `needs_you` state, and the attach clears it. The client keeps the session's
stream running through this attach, with no replay of the screen. When the user closes the list
without Enter, the client sends an attach only if it lost the attachment, for example across a
daemon reconnect.

## Rows and grouping

The client keeps a copy of the sessions of every daemon it connects to, and the list builds its rows
from that copy. One row shows, from left to right: the state glyph, the name, the daemon, the place,
the repository, the agent, the message (the last status the agent reported) and the age (the time
since the session entered its state).

`g` cycles three groupings: flat, by repository, and by place, the machine a session runs on. The
config's `list.grouping` sets the grouping the list opens with. In both grouped modes, the pinned
sessions of every daemon form one group at the top.

A sub-session is a session that another session spawned. It lists under its parent, at any depth, in
the group of the session at the top of its parent chain. A session whose parent chain loops back to
it lists at the top level, so every session lists once.

The selection belongs to a session, so it stays on that session when a state change moves the
session to another row. A key acts on that session even when a change in the sessions moved its row
before the next frame. The list keys each row by its daemon and its session id, because two daemons
can each hold a session with the same id.

The columns change with the grouping and the terminal's width:

- The daemon column shows only when the sessions come from more than one daemon, and never in place
  mode. Repository mode drops the repository column.
- In place mode the group header names the place. A place can hold sessions that reach the client
  through different daemons, and a row in such a group shows `via <daemon>` in the place column.
- When the terminal is narrower than 90 columns, a row shows only the state glyph, the name, the
  message and the age.

The age stays blank for a `running` session. The client takes the age from `stateSince`, the time it
saw the session enter its state, and keeps that time across a reconnect to the daemon. A session
that was already in its state at the client's first listing has no `stateSince`, so its age stays
blank until its state next changes.

Inside a group, sessions sort by state in the order `needs_you`, `done`, `running`, `exited`,
`unknown`, then by the most recent attach. Groups sort by their first session, then by label. A
repository group's label adds the daemon name, then parent folders, until it differs from every
other group's label, so two groups never share a label.

## Jump mode

`f` starts jump mode, and it shows no label yet. The user looks at the name they want and types a
letter they can see in it.

A typed letter matches anywhere in a session's name, with case ignored, and each further letter
narrows the match the way a search does: `t`, then `u`, keeps the names that hold `tu`. Rows that
match stay lit, and the rows that do not fade as the rest of the panel fades. The matched letters
show in blue. When no row matches, the last line reads `no match`, and Backspace takes the last
typed letter back.

- When one row matches, the client picks it at once, with no label.
- When several rows match, each gets a label written over the letter right after its first match, in
  amber. With `t` typed, `tui-beautiful` shows as `tai-beautiful`, so the user presses `a`. A name
  that holds the match more than once gets one label, at its first match. A match that ends the name
  has no letter to write over, so its label sits right after the name.

A label never clashes with typing one more letter of a name: the client takes label letters only
from letters that never follow a match in any lit row. A row that no further typing can single out,
such as `ab` among `aba`, `abb` and the rest once `ab` is typed, always gets a label. When the free
letters run out, the other rows show none, and the user keeps typing letters of the name to narrow
them. When the rows that typing cannot single out outnumber the free letters, every lit row gets a
two-letter label, whose first letter is typed first.

Typing a label on a live session attaches it. Typing a label on an exited session selects its row
and attaches nothing. Esc leaves jump mode and keeps the list open.

## Ending a session

`X` ends a session: the daemon stops the agent and removes the session from the fleet. The client
first shows a prompt on the panel's last line, and sends nothing until the user answers `y`. When
the session is pinned, the client shows a notice to unpin it first and asks nothing.

After `y`, the client sends `session.forget` with `refusePinned` set and without `refuseLive`, so
the daemon stops a live session before it removes it. Some execution targets, such as an imp, give
each session a machine of its own, and ending the session deletes that machine. For such a session
the daemon answers the first `session.forget` with a confirm token in place of ending it. What the
client does next depends on the prompt the user answered:

- When the prompt named the machine, the client sends `session.forget` again at once with the token.
  The prompt names the machine when the session's descriptor, the record the daemon sends for each
  session, holds `canDestroyHost: true`.
- Otherwise the client shows a second prompt that names the machine, and sends the token only after
  the user answers `y`.

A sub-session on its parent's machine deletes no machine, so the daemon ends it on the first call.
When the session has ended sub-sessions, the prompt adds that it removes them, with their count. The
client counts every ended sub-session, so the count can include one the daemon keeps, and it never
misses one the daemon removes. When the session's machine is asleep, the daemon refuses with
`host_asleep`, and the client shows a notice that tells the user to attach to wake the machine, then
end the session.

When the daemon keeps the session's workspace folder, the list shows a notice that names the folder
and the reasons. When the ended session was the attached one, the client goes home and shows the
notice on home. The next opening of the list drops that notice.

`K` kills a live session after a prompt: the agent stops, and the session stays in the list as
exited. On a dead session `K` does nothing, and the key bar on the panel's
[last line](#the-last-line) shows `X end` in its place. `X` is the only key that deletes a machine.
Attaching a session is the only way to mark it read.

While a prompt for `X` or `K` is open, `y` confirms it, and any other key cancels it. The leader key
cancels the prompt and closes the list. When the session leaves the fleet while its prompt is open,
the client drops the prompt, and the next key acts on the list.

The terminal can deliver several keys in one input chunk, such as letters typed fast. The client
applies them one at a time, so a key that changes the mode hands the keys after it to the new mode.
A leader that shares a chunk with typing for the attached session opens the list, and the list takes
the keys after it. A leader byte inside a bracketed paste stays text for the session.

## The last line

The panel's bottom line shows the key bar, unless one of these needs it. When several do, the first
in this list wins:

1. a prompt;
2. the filter the user is typing, or `no match` when the letters typed in jump mode match no row;
3. a notice, such as the result of an action;
4. the daemons that are down, all on one line;
5. the advice to update a daemon that runs an older build.

A prompt grows upward from the bottom line over as many lines as it needs, so the user always sees
the action, what it deletes and the keys that confirm it. The list cuts every other text to one
line. In a window too short for the whole panel, the client drops list rows first, then the borders,
and a prompt taller than the window keeps its last lines, which hold the keys.

## Motion

The panel fades in, and the rows fade in one after another, each starting a step after the row above
it. The whole open, the last row included, ends within a fixed time whatever the row count, so the
step shrinks as the list grows, and a short list keeps a visible stagger. The close is a shorter
fade when the list closes back to a session or to home. When a screen such as the spawn picker
replaces the list, the list closes at once. A close that starts during the open fade, or an open
that starts during the close fade, starts from the levels the other fade had reached, so the panel
never jumps. With the config's `animations` off, the panel opens and closes in one frame. The
durations are constants in [`constants.ts`](../../../packages/tui/src/session-list/constants.ts).

The panel paints no fill of its own: every cell of the panel keeps the terminal's default
background, apart from the border and the tint on the selected row. The panel dims the screen behind
it, apart from the terminal's last row, so the [fleet bar](./fleet-bar.md) stays readable. The panel
lays itself out again on each frame while it is open. While it fades out, it keeps the input it last
drew, because the list's state can be gone by then, and lays that input out again when the
terminal's size changes.

The panel asks the [frame clock](./compositor.md) for frames only while something on it moves:

- While a fade runs, it asks for a frame at the clock's frame interval.
- While a row shows a running session, it asks for a frame each time the row's spinner turns, at the
  spinner rate of the [fleet bar](./fleet-bar.md).
- While a row shows an age, it asks for a frame at the moment the first shown age next changes: each
  second, then each minute, hour or day, as the age's unit grows.

With no fade, no running session and no age, the panel asks for no frame. The clock skips a tick
that runs late, so the last tick of a close fade can be skipped. After the close fade ends, the
panel therefore asks for one more frame, which draws the screen without the panel, so no faint panel
stays on the screen.
