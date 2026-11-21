# Home

Home is the screen the TUI shows when no session is attached. It shows the `atc` wordmark, one line
that counts the sessions, and the keys that open the session list and spawn a session. Home is a
layer of the [compositor](./compositor.md). The compositor builds each frame in a cell buffer, one
cell per terminal cell, and home writes its cells into that buffer. Home sets a background colour
only on the wordmark cells that need two colours, as [The wordmark](#the-wordmark) says, and leaves
every other cell at the terminal's default background. Home then sits on the user's own terminal
theme. [The design](../../design/tui-redesign/home.md) holds the target screens and the pixel
geometry of the wordmark.

```text
                        [ atc ]           the wordmark, sized to the window

              15 sessions  ·  ◆ 2 need you

                ctrl+space  sessions
                         n  new
```

## When home shows

Home is the bottom layer of the compositor whenever no session is on screen:

- when the client has no session attached;
- when the [session list](./session-list.md) is open and no live session is behind it, such as a
  list opened from home, or a list that stays open after the attached session ends or dies. Home is
  then drawn under the list, which dims it as it dims a session. The list never sits over a blank
  screen.

Help, the spawn picker and the question that the client asks before it restarts the daemon are drawn
by the screen emulator, a full-screen renderer apart from the compositor's layers. While one of
those screens shows, home is hidden. Home comes back when the screen closes.

Each time the client goes to home, it clears the screen emulator and hides the terminal's cursor.
The text of an earlier screen then never shows through, and the cursor never shows on home.

## What home draws

Home keeps no state of its own, apart from a cache of each wordmark's pixels. On each frame it reads
the client's copy of the sessions on each daemon. Home never asks the compositor for a frame, so it
never animates. It redraws when the compositor draws a frame for another reason: a change to the
sessions, a notice, or the window size. The compositor writes only the cells that changed, so a
frame that changes nothing on home writes nothing.

Home stacks [the wordmark](#the-wordmark), the fleet line and the keys, and centres the stack in the
window from top to bottom. It leaves two blank rows under an outline wordmark and one under the
bitmap or text wordmark, then one blank row under the fleet line. It centres the wordmark and the
fleet line from left to right. It centres the keys as one block, with each key right-aligned in bold
blue and its label after it in dim text.

The fleet line counts the sessions that the session list shows, so it leaves out the sessions of a
daemon that is down. It reads `<n> sessions`, `1 session` or `no sessions`. While `k` of those
sessions are in the `needs_you` state and `k` is above zero, the line ends in `  ·  ◆ <k> need you`.
When the line is wider than the window, home drops that whole ending first, then cuts the count with
`…`.

The keys that home lists are:

- the leader key, shown as the config's `leader` value, such as `ctrl+space`, which opens the
  session list;
- `n`, which opens the spawn picker;
- `R`, which restores the fleet.

Home lists `R` only while the local daemon's saved fleet holds a session that has stopped, which a
restore would start again. Home reads the saved fleet again each time a session starts, ends or
loses its terminal.

Two more keys work on home, and home lists neither: `r` opens the spawn picker to resume an earlier
conversation, and `q` quits the client. A key row wider than the window ends in `…`.

### The wordmark

Each wordmark has a smallest window that it fits. `pickWordmark` picks the largest wordmark that
fits, by both columns and rows:

| Wordmark                | Smallest window, in columns by rows |
| ----------------------- | ----------------------------------- |
| large outline, `s10`    | 164 by 50                           |
| small outline, `xs8`    | 136 by 40                           |
| bitmap                  | 30 by 10                            |
| the word `atc`, in bold | any                                 |

Home draws the outline and bitmap wordmarks in pixels, two in each terminal cell: `▀` draws the top
half of a cell, and `▄` draws the bottom half. When both pixels of a cell are on, `▀` draws the top
pixel in the cell's foreground colour, and the cell's background colour draws the bottom pixel.

Home builds the outline wordmark from signed distance fields. The a and the c are rounded rectangles
with a smaller one cut out of each, and the c has a further cut that opens its right side. The stems
and the crossbar of the t are plain rectangles. Every straight edge lies on a pixel edge, so only
the curves have part-covered pixels. Home blends each part-covered pixel toward the terminal's
background colour, which the compositor reads from the terminal at start. On a terminal that shows
16 colours, home leaves a pixel off when its colour would show as the palette's black.
[Colour](./compositor.md#colour) says how the compositor finds the terminal's background colour and
the number of colours it shows.

The colour of both pixel wordmarks runs from `#eef1f8` on their top row of pixels to `#c4cde4` on
their bottom row. Home draws the bitmap wordmark with every pixel fully on or off. Its strokes are
one pixel wide, and a blended stroke that thin shows as gaps.

## The notice line

Over an attached session, the client shows its notices on the last row of the terminal, in place of
the [fleet bar](./fleet-bar.md). Home leaves the last row empty, and shows the notices on one amber
line, centred, one blank row under the keys. They show in this order, joined by `  ·  `:

- `@<daemon>`, the name of the daemon the client is on, when it is not the default daemon;
- the client's one current notice, such as a failed call. After the user ends the attached session,
  the notice gives the path of the folder that atc kept. A notice shows until it times out or the
  session list next opens;
- `⟳ waiting for daemon`, `⟳ restarting daemon` or `⟳ update ready`, for the state of the daemon.

The notice line is not part of the stack, so the stack stays where it is when a notice shows or
goes. In a window too short for the blank row, the notice line sits right under the keys, and with
no row left, home leaves it out. A notice line wider than the window ends in `…`.
