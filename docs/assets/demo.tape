# Records docs/assets/demo.gif. Run `scripts/record-demo.sh` from the repo root: it
# starts an isolated daemon with staged sessions and a curated directory list, then
# plays this tape against it.

Output docs/assets/demo.gif

Set Shell "zsh"
Set FontSize 18
Set Width 1100
Set Height 660
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

Type "atc"
Sleep 400ms
Enter
Wait+Screen /session list/
Sleep 1s

# spawn: agent, directory, name, first prompt
Type "n"
Sleep 900ms
Enter
Sleep 900ms
Type "atc"
Sleep 900ms
Enter
Sleep 700ms
Type "haiku"
Sleep 500ms
Enter
Sleep 700ms
Type "write me a haiku"
Sleep 500ms
Enter
Sleep 5s

# the session list over the running session; filter to a staged session and attach it
Ctrl+Space
Sleep 2s
Type "/rubber-duck"
Sleep 700ms
Enter
Sleep 3s

# and back to the one we spawned
Ctrl+Space
Sleep 1.2s
Type "/haiku"
Sleep 700ms
Enter
Sleep 2s

# leave the client; every session keeps running in the daemon
Ctrl+Space
Sleep 800ms
Type "q"
Sleep 1.5s
