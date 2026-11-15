# session-messages

Check that a message you send with `atc_message_send` reaches the session, and that
`atc_message_get` gets it back as delivered.

Start a run on `local`, and pass `doctor`, as steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) say. Then run the journey's lines in order.

- Treat a tool call that gives `data.isError: true` as a failed line. A tool that fails still exits
  0 with `ok: true`, and gives the reason in `data.content`.
- At the first failed line, run the last line, `action forget-session`, and skip `done`. Then go on
  as step 5 of Check a change says. `forget-session` stops the session if it still runs, and does
  nothing when no session has the name.
- Replace `<home>` with `data.endpoints.home` from `up`, `<session_id>` with
  `data.structuredContent.id` from the spawn call, and `<message_id>` with
  `data.structuredContent.message` from the send.
- The spawn starts the stand-in claude that `up` installs, with no extra argument. The stand-in runs
  `atc tap`, which takes each message atc hands the session and prints it on the session's terminal
  as one JSON line. A real claude gives the message to its model instead.
- When the get gives `status` `queued`, the tap has not taken the message yet. Run the get up to
  three more times, a second apart, before you count it as a failed line. The stand-in never answers
  a message, so `delivered` is the last status it reaches.

## Journey

```bash
bun verify use --feature session-messages
bun verify mcp call atc_session_spawn --server atc --args '{"cwd":"<home>","name":"wv-message"}'
bun verify mcp call atc_message_send --server atc --args '{"session":"<session_id>","text":"check the hangar"}'
bun verify mcp call atc_message_get --server atc --args '{"message":"<message_id>"}'
bun verify mcp call atc_terminal_read --server atc --args '{"session":"<session_id>"}'
bun verify action forget-session --name wv-message
```

## End state

Each field below sits under `data` of the tool call named.

- Each tool call gives `isError: false`.
- The send gives a message id in `structuredContent.message`.
- The get gives `structuredContent.text` `check the hangar`, `structuredContent.session`
  `<session_id>`, and `structuredContent.status` `delivered`.
- The terminal read gives a `content` text item with the tap's line, which holds
  `"text":"check the hangar"`. The envelope escapes its quotes, as `\"text\":\"check the hangar\"`.
