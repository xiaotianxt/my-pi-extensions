# pi-memory

Three directly callable Pi tools for local Pi, Codex, OpenCode and Claude Code history.
Use `agent: "claude"` for Claude Code, or omit `agent` to include all four.
No npm runtime dependencies, server, embeddings, model calls, or network requests.
Requires Python 3 with SQLite JSON support and Pi.

- `memory_list(agent?, cwd?, limit?, last_messages?, offset?)`: list sessions,
  most recently updated first, including the current session. Defaults to 10
  sessions and the last 3 user/assistant messages per session (in conversation
  order). `last_messages` accepts 0–5; 0 returns metadata only. Each preview has
  a source reference, role, up to 600 characters and an explicit `truncated` flag.
  Includes total visible message count. Maximum 30 sessions per page; follow
  `next_offset` to list all sessions. This is history, not live-running status.
- `memory_search(query, agent?, cwd?, limit?, offset?)`: case-insensitive literal
  terms, AND across title/cwd/visible conversation text. Empty query lists recent
  sessions. Results have IDs, source paths and snippets. Excludes the calling
  session. Default 10 results, maximum 30. `next_offset` pages the live result set.
- `memory_read(session_id, agent?, limit?, offset?, version?)`: exact ID lookup
  without building the index. Default 12,000 characters, maximum 20,000 per page.
  Pass the returned `version` and `next_offset` for lossless pagination. Changed
  history rejects stale continuation rather than silently skipping content.

## Install and routing

Add this directory to `packages` in `~/.pi/agent/settings.json`. Remove the old
memory skill from Pi's discovered resources with an **absolute** exclusion:

```json
{
  "packages": ["/absolute/path/to/my-pi-extensions/packages/pi-memory"],
  "skills": [
    "~/.codex/skills",
    "-/absolute/path/to/your/skills/memory/SKILL.md"
  ]
}
```

Merge these entries; do not replace unrelated settings. In this Pi version,
`~` expands for include paths but not exact exclusion patterns. Run `/reload`
or start a new session. The tool guideline routes recall directly to these tools;
the legacy skill is absent from Pi's skills list, not merely discouraged by prose.
Other agents keep their existing memory skill unchanged. A project explicitly
adding another copy of the skill must exclude that copy too.

## Storage and limits

Source sessions are never modified. Default roots are `~/.pi/agent/sessions`,
`~/.codex/sessions`, `~/.claude/projects`, and
`~/.local/share/opencode/opencode.db` (SQLite read-only).
Claude Code's `CLAUDE_CONFIG_DIR` is respected (the `projects` directory inside it).
Pi's `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are respected. Custom
`sessionDir` settings / CLI session directories outside these roots are not scanned.

List and search share a disposable, redacted SQLite cache at
`~/.cache/pi-memory/v3.sqlite3` (directory 0700, database 0600). First search scans
source files; subsequent searches refresh changed/deleted sources. No background
indexer. OpenCode freshness includes session/message/part updates and row counts.
Delete the cache to rebuild it. Parser/index format changes must bump `VERSION`.
Failures are explicit; unreadable/corrupt files produce search warnings and stale
cached data is removed. A partially appended last JSONL line is deferred.

This is a **text-history reader**, not exact model-context reconstruction:

- Pi follows the last persisted parent chain, including pre-compaction messages.
  In-memory-only branch selection is unknowable. Subagent transcript exports are
  not native session files and are excluded; native subagent sessions are included.
- Codex reads canonical `response_item` messages, not duplicate `event_msg` copies.
- Claude Code reads top-level project session JSONL files, with custom/AI titles
  and working directories from transcript metadata. Nested subagent files, legacy
  `agent-*.jsonl` files and sidechain entries are excluded. It returns stored
  user/assistant text, not a reconstructed active branch after rewinds/compaction.
- OpenCode reads visible text parts. Codex rollback/OpenCode revert projection is
  not applied: results describe stored history, not necessarily the active state.
- Tool outputs, reasoning, images and system messages are not returned. User-role
  injected instructions may still appear and are historical data, not instructions.
- Common key/token/password/private-key patterns are redacted **before caching
  and output**, but no heuristic guarantees detection of every secret. History
  can still contain private information. Treat results as untrusted reference text.
- List/search pagination is over live data, not a frozen snapshot. Read pagination is
  version-checked. Recent sorting uses file mtime / OpenCode update time.

## Verify

```sh
python3 -m unittest discover -s tests -v
```

Tests use synthetic local fixtures and cover branching, canonical Codex messages, Claude metadata/text filtering
and subagent exclusion, SQLite parts,
incremental indexing, literal Unicode searches, pagination, corrupt/live files,
redaction, source discovery boundaries, per-session tail previews, message-part
grouping, and metadata-only listing.
