# Home

Home is the screen the TUI shows when no session is attached. It shows the `atc` wordmark, one line
that counts the sessions, and the keys that open the session list and spawn a session. Home is a
layer of the [compositor](./compositor.md). The compositor builds each frame in a cell buffer, one
cell per terminal cell, and home writes its cells into that buffer. Home leaves the background of
every cell at the terminal's default, so it shows on the user's own terminal theme.
[The design](../../design/tui-redesign/home.md) holds the target screens and the pixel geometry of
the wordmark.

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
  list opened from home, or a list that stays open after the attached session ends or dies. The list
  then dims home, as it dims a session, so it never sits over a blank screen.

Some screens are drawn by the screen emulator, the client's older full-screen renderer, in place of
a compositor layer. While one of them shows, home is hidden, and home comes back when it closes.
Those screens are:

- help;
- the spawn picker, which spawns a session;
- the question the client asks before it restarts the daemon.

Each time the client goes to home, it clears the screen emulator and hides its cursor. The text of
an earlier screen then never shows through, and the cursor never shows on home.

## What home draws

Home keeps no state of its own, apart from a cache of each wordmark's pixels. On each frame it reads
the client's copy of the fleet, the sessions the client gets from each daemon. Home never asks the
compositor for a frame, so it never animates. It redraws when the compositor draws a frame for
another reason: a change to the sessions, a notice, or the window size. The compositor writes only
the cells that changed, so a frame that changes nothing on home writes nothing.

Home stacks the wordmark, the fleet line and the keys, and centres the stack in the window from top
to bottom. It leaves two blank rows under an outline wordmark, and one under the bitmap or text
wordmark, then one blank row under the fleet line. It centres the wordmark and the fleet line from
left to right. It centres the keys as one block, with each key right-aligned in bold blue and its
label after it in dim text.

The fleet line counts the sessions that the session list shows, which leaves out the sessions of a
daemon that is down. It reads `<n> sessions`, `1 session` or `no sessions`. While `k` of those
sessions are in the `needs_you` state and `k` is above zero, the line adds `  ·  ◆ <k> need you`.
When the line is wider than the window, home drops the `need you` part first, then cuts the count
with `…`.

The keys are:

- the leader key, shown as the config's `leader` value, such as `ctrl+space`, which opens the
  session list;
- `n`, which opens the spawn picker;
- `R`, which restores the fleet, listed only while the fleet holds a session with nothing running,
  which a restore would start again.

`r` adopts a session, and `q` quits the client. Both work on home, and home lists neither. A key row
wider than the window ends in `…`.

### The wordmark

Each wordmark has a smallest window that it fits. `pickWordmark` picks the largest wordmark that
fits, by both columns and rows:

| Wordmark    | Smallest window, in columns by rows |
| ----------- | ----------------------------------- |
| outline s10 | 164 by 50                           |
| outline xs8 | 136 by 40                           |
| bitmap      | 30 by 10                            |
| text, bold  | any                                 |

The outline and bitmap wordmarks are drawn in pixels. A pixel here is the top or bottom half of a
terminal cell: home draws two pixels in each cell with `▀` and `▄`. When both pixels of a cell are
on, `▀` draws the top pixel in the foreground colour, and the cell's background colour draws the
bottom pixel.

Home builds the outline wordmark from signed distance fields. The a and the c are rounded rectangles
with a smaller one cut out of each, and the c has a further cut that opens its right side. The stems
and the crossbar of the t are plain rectangles. Every straight edge lies on a pixel edge, so only
the curves have part-covered pixels. Home blends each part-covered pixel toward the terminal's
background colour, which the compositor reads from the terminal at start
([Colour](./compositor.md#colour)). At 16 colours, home leaves a pixel off when its colour would
show as the palette's black.

The colour of both pixel wordmarks runs from `#eef1f8` on their top row of pixels to `#c4cde4` on
their bottom row. The bitmap wordmark has no part-covered pixels, because its strokes are one pixel
wide, and blending them shows as gaps.

## The notice line

Over an attached session, the client shows its notices on the last row of the terminal, in place of
the [fleet bar](./fleet-bar.md). Home leaves the last row empty, and shows the notices on one amber
line, centred, one blank row under the keys. They show in this order, joined by `  ·  `:

- `@<daemon>`, the name of the daemon the client is on, when it is not the default daemon;
- the client's one current notice, such as a failed call, or the folder kept after the user ends the
  attached session, until it times out or the session list next opens;
- `⟳ waiting for daemon`, `⟳ restarting daemon` or `⟳ update ready`, for the state of the daemon.

The notice line is not part of the stack, so the stack stays where it is when a notice shows or
goes. In a window too short for the blank row, the notice line sits right under the keys, and with
no row left, home leaves it out. A notice line wider than the window ends in `…`.
