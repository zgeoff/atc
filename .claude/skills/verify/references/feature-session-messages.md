# session-messages

Check that a message sent with `atc_message_send` reaches the session, and that `atc_message_get`
reads it back with a status.

Start the environment first: `bun verify up`, then `bun verify doctor`, as steps 2 and 3 of the
verify skill's Check a change say. Run the journey's lines in order. At the first line that exits
non-zero, skip to the cleanup line at the end of the journey, run it, and count the feature as
failed. The cleanup line leaves the daemon with no session for the next journey.

- atc hands a message to a session through the session's message tap. The stand-in claude starts a
  tap, which prints each message it gets on the session's screen as one JSON line with the message's
  `text`. A real claude hands the message to the model instead.
- The stand-in never answers, so the message stays `delivered`. `queued` means the tap has not taken
  it yet: read again.
- `<home>` stands for `data.endpoints.home` of `up`. `<session_id>` stands for
  `data.structuredContent.id` of the spawn call, and `<message_id>` for
  `data.structuredContent.message` of the send.
- Check `data.isError` on each call. A tool that fails still gives `ok: true`, with
  `data.isError: true` and the reason in `data.content`.

## Journey

```bash
bun verify use --feature session-messages
bun verify mcp call atc_session_spawn --server atc --args '{"cwd":"<home>","name":"wv-message"}'
bun verify mcp call atc_message_send --server atc --args '{"session":"<session_id>","text":"check the hangar"}'
bun verify mcp call atc_terminal_read --server atc --args '{"session":"<session_id>"}'
bun verify mcp call atc_message_get --server atc --args '{"message":"<message_id>"}'
bun verify action forget-session --name wv-message
```

## End state

Each field below sits under `data`.

- Every call gives `isError: false`.
- The send gives a `structuredContent.message` id and a `structuredContent.status`.
- The text in `content` of the read holds `"text":"check the hangar"`, in the line the tap printed.
- The get gives `structuredContent.text` `check the hangar`, `structuredContent.session`
  `<session_id>`, and `structuredContent.status` `delivered`.
