# session-messages

Check that a message you send with `atc_message_send` reaches the session, and that
`atc_message_get` gets it back as delivered.

Run the journey on a `local` run where `doctor` has succeeded. Steps 2 and 3 of
[Check a change](../SKILL.md#check-a-change) start one, and each later journey reuses it. Run the
lines in order, and check each value in End state when its command returns.

- A line fails when its command exits non-zero, or when `mcp call` gives `data.isError: true`.
  `bun verify mcp call` exits 0 when the tool fails, and puts the tool's reason in `data.content`.
- After a failed line, run the last line, `action forget-session`, and skip `done` on this pass.
  Then go on as step 5 of Check a change says. `forget-session` stops the session if it still runs,
  and does nothing when no session has the name.
- Replace each placeholder with a value from an earlier command:
  - `<home>`: `data.endpoints.home` from `up`;
  - `<session_id>`: `data.structuredContent.id` from the spawn call;
  - `<message_id>`: `data.structuredContent.message` from the send. The field holds the message's
    id, and its text is in `text`.
- The session runs the stand-in claude, which runs `atc tap`. The tap takes each message atc hands
  the session, and prints it on the session's terminal as one JSON line.
- When the get gives `status` `queued`, the tap has not taken the message yet. Run the get up to
  three more times, a second apart. A get that still gives `queued`, or any status other than
  `delivered`, is a failed line. The stand-in never answers a message, so it never goes past
  `delivered`.

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

Each bullet names an `mcp call`, and each value sits under that call's `data`.

- Each `mcp call` gives `isError: false`.
- The send gives a message id in `structuredContent.message`.
- The get gives:
  - `structuredContent.text` `check the hangar`;
  - `structuredContent.session` `<session_id>`;
  - `structuredContent.status` `delivered`.
- The terminal read gives a `content` text item that holds the tap's line, with
  `"text":"check the hangar"` in it. When you search the command's raw output instead of the parsed
  JSON, look for `\"text\":\"check the hangar\"`: `bun verify` escapes the quotes.
