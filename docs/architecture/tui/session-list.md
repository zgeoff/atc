# The session list

The session list is a see-through panel that the leader key opens over home or over the attached
session. It is a layer of the [compositor](./compositor.md): the panel writes cells into the cell
buffer, blends them over what is below, and dims the layers below it. It never goes through the
screen emulator, so the session behind it keeps drawing while the list is open.

## The attachment outlives the list

Opening the list does not detach the session. The client keeps one attachment, held apart from the
list's focus, so the session keeps streaming and resizing behind the panel. This is why the dimmed
session stays live. The attachment ends only when the user goes home, quits, or attaches a different
session, which first lets the old one go so the daemon can size it for its other clients.

Pressing Enter on the session that is already attached closes the list and sends the daemon an
attach again, because the daemon marks a session read and clears its need when it hears an attach.
The client keeps the session's stream as it is. Closing the list without Enter re-requests an attach
only when the attachment was lost, such as after a daemon reconnect. If the focused session leaves
the fleet while the list is open, the client goes home.

## Rows and grouping

The list collects its rows from the fleet mirror in three groupings: flat, by repository and by
place. `g` cycles them, and the config's `list.grouping` sets the one the list opens with. Pinned
sessions of every daemon form one group at the top. The selection follows a session, not a row
number, so a session that changes state and moves in the sort keeps the selection. Sort ids carry
the daemon, so two daemons that hold the same session id stay apart.

In place mode the place column gives way to the daemon a session comes through, and the daemon
column never shows. Under 90 columns the list drops its optional columns and keeps the mark, the
name, the message and the age.

## Jump mode

`f` puts a letter on each visible row. The letters come from the home row first. No label is a
letter that the visible names would read as a typed filter: with nothing typed, a label avoids every
letter in the names, and after the user types text, a label avoids the letter that follows each
occurrence of that text. When the letters run out, labels take two letters. Typing narrows the rows
and a complete label attaches its session. A label on an exited row moves the selection and attaches
nothing.

## Ending a session

`X` sends `session.forget` with `refusePinned` set and without `refuseLive`, because the daemon
stops a live session before it forgets it. When the target would destroy the session's host, the
daemon answers with a token, and the client asks again with the machine named. After that answer the
client resends the request at once with the token. `K` stays for live sessions and keeps the session
listed as exited.

A prompt on the last line holds the key, and any key but `y` cancels it. The leader key cancels it
too and closes the list.

## The last line

The panel's last line shows the first of these that applies: a prompt, the filter or the jump
`no match` text, a notice, the daemon line, the update advice, then the key bar. The advice for a
daemon that runs an older build replaces the key bar whole.

## Motion

The panel fades in, and each row follows in a cascade that starts a little later for each row. The
close fades faster than the open, and only when the base is a session or home: a screen that takes
over from the list, such as the picker, closes it at once. With `animations` off, the panel opens
and closes in a single frame. The panel asks the frame clock for a frame at the display rate while a
fade moves, and at a slow tick while a row shows a running session, so an idle list costs nothing.
After a close ends, the panel asks for one more frame, which draws the screen without it, so a late
tick never leaves a faint panel on the screen. The timings are constants in the session-list folder
of the TUI package.
