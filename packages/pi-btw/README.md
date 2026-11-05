# pi-btw

Read-only side questions while Pi's main task keeps running.

```text
/btw 现在进展如何？
```

An independent implementation, not a fork of `Fatih0234/btw`.

## Behavior

- Uses the main session's selected model and registered provider, with low reasoning and up to 2,048 output tokens.
- Captures the current branch synchronously through Pi's public `buildSessionContext()` and `convertToLlm()` helpers. Compaction follows the installed Pi implementation.
- Sends a **text transcript**, never historical tool protocol. Missing, duplicate, interrupted, and orphaned tool records cannot create unmatched provider tool calls.
- Keeps real tool output; labels missing results as unknown, not failed or running.
- Makes one streaming request, with no agent loop, tool executors, automatic follow-up, or session writes. Literal JSON/code in an answer is allowed.
- Displays a full-width, opaque, framed overlay so underlying transcript fragments do not remain at either side. Prose is capped at 96 columns; the answer precedes snapshot metadata. Arrow keys, Page Up/Down, Home/End navigate; Enter, Escape, or Ctrl+C closes and cancels only the side request.
- Session shutdown/reload/replacement and tree navigation close the overlay and cancel its request.
- Uses a fresh request session ID and disables prompt caching. No claim of sharing the main task's cache.
- Shows side-request usage in the overlay. It is not added to the main session's persisted usage totals.

## Snapshot boundaries

The answer is based on **recorded messages at invocation**, not live streaming output or the final provider payload. Pi can finish a tool before appending its result, especially in a parallel batch. A missing result is therefore expected, not an error.

Images and hidden reasoning are omitted, as are per-turn system prompts and other extensions' transient `context`/provider payload transformations. The snapshot is not a reproduction of everything the main model saw. Image omissions are reported; no image bytes are sent even if the main session blocks images.

Input history is limited to a conservative UTF-8 byte budget derived from the model's context window and capped at 128 KB. Overflow drops the oldest text and reports that the first retained record may be partial. This is a cost bound and conservative heuristic, not an exact tokenizer. The user's question is preserved; an oversized question is rejected explicitly. Ordinary tool results are not individually truncated.

The authentication facade does not expose a cancellation signal. Closing during an OAuth refresh prevents any later model request or UI update, but cannot itself cancel that shared refresh. Active provider requests do receive the independent abort signal.

## Install

Tested against Pi **0.85.1**; development requires Node 24+.

```sh
npm ci --ignore-scripts
npm run check
npm test
pi install /absolute/path/to/pi-btw
```

Disable any other extension registering `/btw`, then run `/reload` in Pi. There is no `/btw-settings` command in this initial version, and old extension settings are not read.

To keep the old package installed but inactive, use the documented package filter in `~/.pi/agent/settings.json`:

```json
{
  "source": "git:github.com/Fatih0234/btw",
  "extensions": []
}
```

For rollback, remove this local package and restore the old package's extension filter, then `/reload`.

## Development

- `src/context.ts`: current-branch snapshot and bounded text projection.
- `src/request.ts`: registered-provider dispatch and independent cancellation.
- `src/panel.ts`: scrollable streaming answer.
- `src/index.ts`: command and lifecycle ownership.

Tests use real Pi session helpers and in-process fake streams. They cover incomplete tool batches, interrupted history, branch/compaction behavior, omissions, provider dispatch, structured tool rejection, and cancellation during authentication. No paid provider calls are needed.

Local faux-provider TUI checks verified `/btw` during a 15-second main tool call and its layout at 175×35 and 42×18 terminal sizes: the side answer rendered, JSON remained intact, the main task completed with the overlay open, and Escape dismissed it without cancelling the main task. Layout tests also cover CJK, long code, scrolling, and very small terminals.

The initial dependency install reports a deprecated `node-domexception` through Pi's Google SDK development dependency tree. This project does not add a runtime dependency on that package, suppress the warning, or override upstream dependencies; its removal belongs upstream.
