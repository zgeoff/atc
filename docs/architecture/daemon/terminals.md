# Terminals

Each pty session's agent runs on a pseudo-terminal the daemon owns, and the daemon reads every byte
the agent prints, whether or not a client is attached. Those bytes feed a screen model per session,
a headless terminal emulator (`@xterm/headless`) that holds the current screen and a short
scrollback. The screen model is what makes attaching instant: a client that attaches gets the screen
as it stands, without waiting for the agent to repaint itself. A slow client never stalls the
pseudo-terminal reader or any other client.

[Sessions](./sessions.md) covers what a session is, and the [protocol](../protocol/protocol.md)
covers the connection the output rides.

## Attaching

A client attaches to one session at a time, its focused session, and only attached clients and
[watchers](#watching) receive that session's output, so an unfocused session costs a client nothing.

1. The client sends its terminal size with the attach. The daemon applies the session's new
   effective size first, so the replay renders at the size the client will see.
2. The daemon waits for the screen model to finish parsing the output it holds, then sends a replay:
   a screen clear, the serialized visible screen, and the input modes the agent turned on, such as
   mouse reporting and the keyboard protocol.
3. Live output follows the replay. The replay goes out as ordinary output events, so the client
   cannot tell replay from live output and needs no separate path for it.

Output events carry a sequence number per session, so a client can detect a gap. The screen model
lives in memory only. A session that ends keeps its last screen until the daemon drops the session,
so a caller can still read what a dead session last showed, as plain text through a screen read.

## Watching

A watcher receives a session's output without attaching to it, so it never types, never resizes, and
never counts toward the session's size. Watching is how a read-only viewer, such as a web page that
shows a session's terminal, follows a session without shrinking it for the people attached to it.

The daemon answers a watch with the replay itself, the session's size, and the sequence number of
the last output the replay holds. The daemon adds the watcher before it captures the replay, so
output the agent prints during the capture reaches the watcher as events. Every event at or below
the answer's sequence number is already in the replay, and the watcher drops it. The first event
above that number continues the screen with no gap and no repeat.

A watch leaves the session's attach record alone: a watch marks nothing read, and the daemon
announces neither the watch nor its end. A dropped-output repair sends a watcher the desync event
without the repaint, because a repaint sent as output events has no boundary the watcher could tell
from live output. The watcher watches again for a fresh replay instead.

## Backpressure

Every connection has a bounded outbound queue, and the queue never cuts a line in half. Bun's socket
write accepts only part of a buffer when the kernel is full, so the queue holds the rest and flushes
it when the socket drains. What happens on overflow depends on what overflows:

- **Terminal output is droppable.** When a chunk of a session's output does not fit in a client's
  queue, the daemon drops it and every later chunk of that session for that client, and counts the
  bytes. The queue still sends the output it holds. Once the queue drains, the daemon sends a desync
  event with the count, then a full repaint from the screen model. A lagging client wants the
  current screen, not the backlog it missed, and the repaint replaces every dropped chunk, so a
  stream cut in the middle of an escape sequence never corrupts the client's terminal.
- **Control is not droppable.** A response or a state event that overflows the queue means a bug or
  a hostile peer, so the daemon closes the connection.
- **A headless session has no stream to attach to.** The daemon refuses an attach to a session with
  no pseudo-terminal, so a caller reads a headless run through its transcript and its latest result.
  The transcript on disk is the durable copy, and the socket is no durability layer.

Control and output share one ordered socket, so ordering between input, resize and output holds by
construction. The daemon splits large output into chunks under the line cap, and a response waits
behind every chunk queued before it.

## Several clients on one session

Any number of clients can attach to one session and type into it. Three rules cover the conflicts
that occur in practice, without a write-lock protocol:

- **Input atomicity.** A client sends one complete key event or paste per input request, and the
  daemon writes each payload to the pseudo-terminal whole. The daemon decodes each client's input
  separately, so a multi-byte character split across reads survives.
- **Effective size.** The session's terminal size is the smallest width and height across its
  attached clients. The daemon debounces size changes and skips a resize that leaves the size as it
  is, so two clients resizing in opposite directions cannot cause a storm of window-change signals.
- **Line atomicity.** A typed line and its submit key go out in order with no other input between
  them, as the next section describes.

A host without the resize capability keeps its terminal at the size it started with, while the
session's screen model follows the attached clients.

## Submitting a line

Raw input goes to the pseudo-terminal exactly as sent. Submitting a line instead types text as one
line and submits it the way the session's agent accepts a line, which the agent's adapter plans. The
plan differs per agent because every agent CLI treats a newline that arrives inside a burst of input
as part of the text, so a line typed with its own newline stays unsent in the composer:

- **Claude Code and gateway agents** get the text between bracketed paste markers, then a carriage
  return as a second write. The markers make the text one paste, so the carriage return reads as
  Enter however the writes arrive. A line that opens with a slash command and an argument goes out
  as typed keys for the command name and a paste for the argument, because Claude Code takes a long
  paste as pasted text, and a slash command pasted whole would reach the model as a message.
- **Codex** gets the command name and the argument as separate pastes with a pause between them,
  because Codex drops keys typed just before a paste, shows a long paste as a placeholder, and stops
  reading its terminal after a read that completes an input event.
- **Grok** gets every line pasted whole, since it runs a long pasted slash command as a command.

The daemon strips paste markers from the text, so the text cannot end its own paste. It reads from
the screen model whether the agent has turned bracketed paste on. Until it has, the text goes
unmarked and can merge with its carriage return into one burst, so the daemon cannot promise the
line is submitted. While a line waits out a pause its agent needs, the daemon queues the session's
other input and writes it after the line's submit key.

A Claude Code session whose latest report shows a permission prompt refuses a submitted line with
`permission_pending`, because a permission menu confirms its highlighted option on the carriage
return that ends the line. A [menu choice](#answering-a-menu) answers the prompt instead. The
refusal starts only when Claude Code sends its notification, which comes some seconds after the
prompt opens, so a line submitted inside that window is not refused.

A submitted line's answer means the daemon wrote the line and its submit key, not that the agent
took it. A headless session takes the line as the prompt of its next turn.

## Answering a menu

A client reads the menu an agent waits on from the screen model, and picks one option by its number
and its label. The agent's adapter reads the menu from the screen text, so only an agent whose
adapter reads menus takes a choice, and only the adapters that run Claude Code do. It reads the menu
as the last `❯` cursor on the screen and the option lines beside it, with the text above them up to
the dialog's border. Claude Code's prompt box also starts with `❯`, so a cursor line between two
rules is no menu.

Claude Code draws a long list, such as the new MCP servers list, a few rows at a time, and marks the
first and last rows with `↑` and `↓` in the cursor's column when options sit out of view. A taller
terminal shows no more rows, because Claude Code caps the window at a fixed count. So a read that
finds a mark reads the whole list with arrow keys. It waits for the screen to go quiet, as a choice
does, moves the cursor up to the first option, then down one option at a time, and moves it back to
where it started. The cursor's own row hides its mark, so the read finds the end of the list when
the cursor passes the last option, onto the item after the list or back to the first option. A list
that fills its window with the cursor on its last row shows no mark at all, though options may sit
below it, so the reader treats it as one that may scroll and the read walks it too. The read holds
the session's other input while it runs and never presses Enter or Escape.

The daemon keeps the whole menu for the session, and numbers each later read that shows part of it
by the option's place in the whole list. A read or a choice made while the list sits scrolled
therefore presses no key to learn the numbers. A read that finds no menu, or a menu that is not part
of the kept one, drops it, and so does a new terminal for the session, so a list that closes and
opens again is read afresh. A choice drops it too before it presses Enter or Escape, and so does any
input from outside a menu read or choice, because each can open another list with the same text and
the same rows in view. A part of the list whose labels match in more than one place gets no number
from the kept menu, since the screen cannot show which place the cursor is in.

A menu read returns a token built from the whole menu's text, its labels, and its ticked boxes, and
a choice carries that token. The cursor is left out of the token, so the choice's own arrow keys
never change it. The daemon runs a choice in five steps, and holds the session's other input until
the last one:

1. It reads the whole menu again and refuses the choice with `menu_changed` when the token differs,
   or with `menu_label_mismatch` when the option's label differs, before it writes anything.
2. It waits until the agent has printed nothing for longer than Claude Code holds a dialog that has
   just opened, then checks the menu again. During that hold Claude Code refuses Enter, and when the
   hold ends it moves the cursor back to the dialog's default option, so a choice made inside the
   hold could pick the default.
3. It presses the arrow key toward the option and waits for the screen to show the cursor on the
   next option. A changed menu stops the choice with `menu_changed`, and a cursor that does not move
   stops it with `menu_busy`.
4. Once the cursor sits on the option, it presses Enter. Enter on an option with a box ticks or
   clears the box and keeps the menu open, so a box menu takes one choice per box and one for its
   confirming item.
5. It answers with the whole menu the screen shows once it stops changing, or none. A new list that
   scrolls past the screen is read whole first, so its token is the one the next choice carries.

Every refusal comes before Enter, so a refused choice never picks an option. Escape is the one other
key a client can press, and it carries the token too, because Escape on Claude Code's folder-trust
dialog exits the agent.
