# Records docs/assets/demo.gif. Run from the repo root with `vhs docs/assets/demo.tape`.
# Needs vhs, ttyd, and ffmpeg on PATH, a working `claude` login, and the default leader key.
# The directory filter below must match one directory in your picker.

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
Type "auth-bug"
Sleep 500ms
Enter
Sleep 700ms
Type "read src/cli.ts and summarise what each subcommand does"
Sleep 500ms
Enter
Sleep 5s

# the session list over the running session
Ctrl+Space
Sleep 3s

# back in
Enter
Sleep 2s

# leave the client; the session keeps running in the daemon
Ctrl+Space
Sleep 800ms
Type "q"
Sleep 1.5s
