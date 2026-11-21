# Home

Home is what the TUI shows with no session attached: the `atc` wordmark, one line of fleet state,
and the two keys a user needs to go on. It is a layer of the [compositor](./compositor.md) that
writes cells into the cell buffer, and it paints no background, so it sits on the user's own
terminal theme. [The design](../../design/tui-redesign/home.md) holds the target screens and the
wordmark's pixel geometry.

```text
                        [ atc ]           the wordmark, sized to the window

              15 sessions  ·  ◆ 2 need you

                ctrl+space  sessions
                         n  new
```

## When home shows

Home is the bottom layer whenever no session shows, in two cases:

- The client is in its home mode: nothing is attached.
- The session list is open and no live session sits behind it. This covers a list opened from home,
  and a list that stays open after the attached session ends or dies, so the panel never sits over a
  blank screen. The panel dims home as it dims a session, a little less.

A prompt that the screen emulator draws, such as the question that asks before a restart, hides home
while it asks. Help and the spawn picker draw through the screen emulator, so they replace home, and
home returns when they close.

Each time the client enters home, it clears the screen emulator and hides its cursor. That keeps the
text of an earlier screen from showing through, and keeps the cursor off home.

## What home draws

The layer reads the fleet mirror on each frame and keeps no state of its own, apart from a cache of
each wordmark's coverage. It asks the frame clock for no frame, so home never animates. A frame that
a fleet change or a resize asks for redraws it, and the compositor writes only the cells that
differ, so a frame that changes nothing writes nothing.

The layer stacks the wordmark, the fleet line and the keys, and centres the stack from top to
bottom. Each wordmark and the fleet line are centred left to right, and the keys are centred as one
block: each key is right-aligned in bold blue, and its label follows in dim text.

The fleet line counts every session in the mirror, across daemons. It adds the `◆ <k> need you` part
only while `k`, the count of sessions in the `needs_you` state, is above zero.

The keys are the leader key, shown as the config's `leader` label, and `n`. While the last fleet has
sessions to restore, a third line lists `R`. `r` (adopt) and `q` work on home without a line. Home
takes every key it took before the redesign.

### The wordmark

`pickWordmark` picks the largest wordmark whose smallest window the window reaches, in columns and
rows at once. There are four: two outline sizes, a hand-drawn bitmap and bold text.

The outline wordmark comes from signed distance fields. The a and the c are rounded rectangles with
a smaller one cut from each, the c has a cut that opens its right side, and the stems and the t's
crossbar are plain rectangles. Every straight edge lies on a whole pixel, so only the curves have
part-covered pixels, which the layer measures with six samples along each axis of a pixel. A cell
holds two pixels, drawn with `▀` and `▄`; a cell whose two pixels are both on takes the lower one as
its background colour. The colour runs from the top of the wordmark to its base, and a part-covered
pixel blends toward the terminal's background colour, which the compositor reads from the terminal
at start ([Colour](./compositor.md#colour)).

The bitmap wordmark has no part-covered pixels, because anti-aliasing a stroke one pixel wide reads
as gaps. The text wordmark is the word `atc` in bold.

## What the old status bar carried

Home has no status bar. The notices it carried show on one line below the keys, in amber, with a
blank row between: the daemon's name when the primary is a named remote daemon, the TUI's notice
(such as the kept-folder notice after the user ends the attached session, or a failed call), and
`⟳ waiting for daemon`, `⟳ restarting daemon` or `⟳ update ready`. The line sits below the stack, so
a notice never moves it. The next opening of the session list drops a kept-folder notice.
