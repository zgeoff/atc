# Records docs/assets/demo.gif. Run `bun run demo:record` from the repo root:
# scripts/record-demo.sh starts two throwaway daemons, a local one and "cloud",
# whose agents are the stand-in in scripts/demo-agent.ts, and
# scripts/drive-demo.ts runs this tape while it drives the fleet.
#
# No step rests on a guessed delay. The tape waits with Wait+Screen for the
# text that proves a beat is on screen, and the drive script moves the fleet
# only on a daemon event that proves the last move landed:
#
# 1. The drive script stages two sessions on each daemon, and starts vhs once
#    every stand-in has reported SessionStart through the hook reporter.
# 2. The tape attaches the orchestrator, then opens the list over it. Leaving
#    the session detaches it, and that SessionDetached event is the only sign
#    of the tape's keys that reaches a daemon, so it starts the next beat.
# 3. After a hold, the drive script sends the orchestrator
#    "start builders: api, ui" with `atc send`. The stand-in reads it through
#    `atc tap` and calls atc_session_spawn through `atc mcp` once per part,
#    so each builder is a sub-session. The beat ends when both builders have
#    reported SessionStart.
# 4. After another hold, the drive script sends builder-ui "ask: ..." with
#    `atc send`, and that stand-in posts a Notification hook, a permission
#    prompt. The beat ends on the SessionState event that shows builder-ui
#    needs you.
#
# Each Sleep here, and each hold, is reading time for the viewer. A Wait or a
# drive step that times out fails `bun run demo:record`. vhs writes demo.gif
# into a temp folder, and record-demo.sh copies it over docs/assets/demo.gif
# once it decodes.

Output demo.gif

Set Shell "zsh"
Set FontSize 18
Set Width 1100
Set Height 660
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set WaitTimeout 30s

Type "atc"
Enter
Wait+Screen /session list/

# one list over both daemons: the local sessions and the cloud ones
Ctrl+Space
Wait+Screen /cloud\s+flaky-test/
Wait+Screen /cloud\s+bench/
Wait+Screen /orchestrator/
Sleep 4s

# attach the orchestrator, then open the list over it
Type "/orchestrator"
Wait+Screen /\/ orchestrator/
Enter
Wait+Screen /demo agent[\s\S]*plan the 2\.0 release/
Sleep 1.5s
Ctrl+Space

# the orchestrator starts two builders, listed under it as they start
Wait+Screen /↳ builder-api/
Wait+Screen /↳ builder-ui/

# one builder asks a question, and needs you
Wait+Screen /1 need you/
Sleep 5s
