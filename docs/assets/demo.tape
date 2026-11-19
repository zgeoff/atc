# Records docs/assets/demo.gif. Run `bun run demo:record` from the repo root:
# scripts/record-demo.sh starts two throwaway daemons, a local one and "cloud",
# whose agents are the stand-in in scripts/run-demo-agent.ts, and
# scripts/run-demo-recording.ts, the drive script, runs this tape while it
# drives the fleet.
#
# No step rests on a guessed delay. The tape waits with Wait+Screen for the
# text that proves a beat is on screen, and the drive script moves the fleet
# only on a daemon event that proves the last move landed:
#
# 1. The drive script stages the orchestrator on the local daemon, and
#    builder-api and docs on cloud. It pins the orchestrator and builder-api,
#    so no row of the list moves when the tape comes back from a session, and
#    starts vhs once each stand-in has settled: builder-api running, the
#    others done.
# 2. The tape opens the orchestrator and types its request. The stand-in
#    reads the line from its terminal, spawns builder-ui on cloud through
#    `atc mcp --daemon cloud`, and messages builder-api the same way.
# 3. The tape opens builder-api, where the orchestrator's message is the
#    newest thing in the pane. atc labels a message from another daemon with
#    the principal the cloud daemon admits, laptop, as the atc-bridge
#    envelope shows it.
# 4. Leaving builder-api detaches it. That SessionDetached event makes the
#    drive script drop a cue file for builder-ui, whose stand-in then
#    messages builder-api through `atc mcp`. The tape opens builder-ui and
#    waits for that message on screen.
#
# Each Sleep here is reading time for the viewer. A Wait or a drive step that
# times out fails `bun run demo:record`. vhs writes demo.gif into a temp
# folder, and record-demo.sh copies it over docs/assets/demo.gif once it
# decodes.

Output demo.gif

Set Shell "zsh"
Set FontSize 18
Set Width 1100
Set Height 660
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Set WaitTimeout 30s

# The shell and the launch stay off the GIF: it opens on the full-screen list.
Hide
Type "atc"
Enter
Wait+Screen /session list/
Ctrl+Space
Wait+Screen /cloud\s+docs/
Show

# the list: the orchestrator here, two sessions on the cloud box
Sleep 1.5s

# open the orchestrator and ask it for a builder
Type "/orc"
Enter
Wait+Screen /builder-api has the API/
Type@25ms "start a builder for the UI on the cloud box and tell builder-api to coordinate with it"
Enter
Wait+Screen /Messaged builder-api/
Sleep 2.5s

# builder-api: the orchestrator's message is the newest thing in its pane
Ctrl+Space
Wait+Screen /cloud\s+builder-ui/
Sleep 1.5s
Down
Enter
Wait+Screen /Agree the orders endpoint with it/
Sleep 2.8s

# builder-ui: new on the cloud box, it has just asked builder-api
Ctrl+Space
Wait+Screen /cloud\s+builder-ui/
Sleep 1.2s
Down 2
Enter
Wait+Screen /Messaged builder-api: What does/
Sleep 3.5s
