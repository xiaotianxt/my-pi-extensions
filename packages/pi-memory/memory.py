"""Read-only conversation adapters; disposable, private SQLite search cache."""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

VERSION = 3
AGENTS = ("pi", "codex", "opencode", "claude")


def redact(text):
    text = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[REDACTED PRIVATE KEY]", text)
    text = re.sub(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b", "[REDACTED]", text)
    text = re.sub(r"(?i)(\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b[\"']?\s*[:=]\s*[\"']?)(?:Bearer\s+)?[^\s\"',;]+", r"\1[REDACTED]", text)
    return text


def text_content(content):
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in (content or [])
                     if isinstance(b, dict) and b.get("type") in ("text", "input_text", "output_text"))


def jsonl(path):
    with path.open(encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                # A live writer may not have finished the last line yet.
                if not line.endswith("\n"):
                    break
                raise ValueError(f"Malformed JSON at {path.name}:{line_no}") from None
            if not isinstance(entry, dict):
                raise ValueError(f"Non-object at {path.name}:{line_no}")
            yield line_no, entry


def parse_claude(path):
    # Claude has no session header; metadata and transcript entries interleave.
    sid, cwd, custom_title, ai_title, messages = None, "", "", "", []
    for line, entry in jsonl(path):
        entry_sid = entry.get("sessionId")
        if entry_sid:
            if sid is not None and sid != entry_sid:
                raise ValueError(f"Mixed Claude session IDs: {path.name}")
            sid = entry_sid
        cwd = entry.get("cwd") or cwd
        kind = entry.get("type")
        if kind == "custom-title":
            custom_title = entry.get("customTitle", "")
        elif kind == "ai-title":
            ai_title = entry.get("aiTitle", "")
        if kind not in ("user", "assistant") or entry.get("isSidechain"):
            continue
        message = entry.get("message", {})
        role = message.get("role")
        if role != kind:
            continue
        text = text_content(message.get("content"))
        if text:
            messages.append((f"L{line}", role, text))
    if not sid:
        raise ValueError(f"Missing Claude session ID: {path.name}")
    return record("claude", sid, cwd, custom_title or ai_title, str(path), path.stat().st_mtime, messages)


def parse_file(agent, path):
    if agent == "claude":
        return parse_claude(path)
    entries = iter(jsonl(path))
    _, header = next(entries, (0, {}))
    expected = "session" if agent == "pi" else "session_meta"
    if header.get("type") != expected:
        raise ValueError(f"Invalid {agent} session header: {path.name}")
    meta = header if agent == "pi" else header.get("payload", {})
    sid = meta.get("id") or meta.get("session_id")
    if not sid:
        raise ValueError(f"Missing session ID: {path.name}")
    title, messages = "", []
    if agent == "pi":
        # Keep only small visible payloads, but retain every parent link.
        nodes, last = {}, None
        linear = header.get("version", 1) == 1
        for line, e in entries:
            if e.get("type") == "session_info":
                title = e.get("name", "")
            key = e.get("id", str(line))
            parent = last if linear else e.get("parentId")
            msg = e.get("message", {}) if e.get("type") == "message" else {}
            role = msg.get("role")
            text = text_content(msg.get("content")) if role in ("user", "assistant") else ""
            nodes[key] = (parent, line, role, text)
            last = key
        seen = set()
        while last is not None:
            if last in seen or last not in nodes:
                raise ValueError(f"Broken session branch: {path.name}")
            seen.add(last)
            parent, line, role, text = nodes[last]
            if text:
                messages.append((f"L{line}", role, text))
            last = parent
        messages.reverse()
    else:
        for line, e in entries:
            p = e.get("payload", {})
            if e.get("type") == "response_item" and p.get("type") == "message" and p.get("role") in ("user", "assistant"):
                text = text_content(p.get("content"))
                if text:
                    messages.append((f"L{line}", p["role"], text))
    return record(agent, sid, meta.get("cwd", ""), title, str(path), path.stat().st_mtime, messages)


def record(agent, sid, cwd, title, source, updated, messages):
    if not title:
        title = next((text for _, role, text in messages if role == "user"), "")
    transcript = "\n\n".join(f"[{ref} {role}]\n{text}" for ref, role, text in messages)
    recent = []
    for ref, role, text in messages[-5:]:
        safe = redact(text)
        recent.append(dict(ref=ref, role=role, text=safe[:600], truncated=len(safe) > 600))
    return dict(agent=agent, session_id=sid, cwd=redact(cwd), title=redact(title)[:180],
                source=source, updated=updated, text=redact(transcript),
                message_count=len(messages), recent_messages=recent)


class Memory:
    def __init__(self, home=None, cache=None):
        self.home = Path(home or Path.home())
        self.roots = {"pi": self.home / ".pi/agent/sessions", "codex": self.home / ".codex/sessions",
                      "claude": self.home / ".claude/projects"}
        if home is None:
            self.roots["pi"] = Path(os.environ.get("PI_CODING_AGENT_SESSION_DIR") or
                                    Path(os.environ.get("PI_CODING_AGENT_DIR", self.home / ".pi/agent")) / "sessions")
            self.roots["claude"] = Path(os.environ.get("CLAUDE_CONFIG_DIR") or self.home / ".claude") / "projects"
        self.db_path = self.home / ".local/share/opencode/opencode.db"
        self.cache = Path(cache or self.home / f".cache/pi-memory/v{VERSION}.sqlite3")

    def sources(self, agents):
        for agent in agents:
            if agent in self.roots:
                root = self.roots[agent]
                paths = root.glob("*/*.jsonl") if agent == "claude" else root.rglob("*.jsonl")
                for path in paths:
                    # Legacy Claude sidechains use agent-*.jsonl alongside main sessions.
                    if agent == "claude" and path.name.startswith("agent-"):
                        continue
                    # pi-subagent exports are tool artifacts, not native sessions.
                    if agent == "pi" and "subagent-artifacts" in path.relative_to(root).parts:
                        continue
                    stat = path.stat()
                    yield agent, str(path), f"{stat.st_mtime_ns}:{stat.st_size}", path
            elif self.db_path.exists():
                with closing(self.open_opencode()) as db:
                    for row in db.execute("""SELECT s.*,
                        (SELECT max(time_updated) FROM message WHERE session_id=s.id) AS message_updated,
                        (SELECT max(time_updated) FROM part WHERE session_id=s.id) AS part_updated,
                        (SELECT count(*) FROM message WHERE session_id=s.id) AS messages,
                        (SELECT count(*) FROM part WHERE session_id=s.id) AS parts
                        FROM session s"""):
                        stamp = f"{row['time_updated']}:{row['message_updated']}:{row['part_updated']}:{row['messages']}:{row['parts']}"
                        yield agent, f"{self.db_path}#{row['id']}", stamp, dict(row)

    def open_opencode(self):
        db = sqlite3.connect(self.db_path.as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA query_only=ON")
        return db

    def parse(self, agent, source):
        if agent != "opencode":
            return parse_file(agent, source)
        with closing(self.open_opencode()) as db:
            rows = db.execute("""SELECT m.id, m.data AS message, p.data AS part
                FROM message m JOIN part p ON p.message_id=m.id
                WHERE m.session_id=? ORDER BY m.time_created,m.id,p.time_created,p.id""", (source["id"],))
            messages = []
            for row in rows:
                role = json.loads(row["message"]).get("role")
                part = json.loads(row["part"])
                if role in ("user", "assistant") and part.get("type") == "text" and part.get("text"):
                    if messages and messages[-1][0] == row["id"]:
                        ref, _, text = messages[-1]
                        messages[-1] = (ref, role, text + "\n" + part["text"])
                    else:
                        messages.append((row["id"], role, part["text"]))
        return record(agent, source["id"], source["directory"], source["title"],
                      f"{self.db_path}#{source['id']}", source["time_updated"] / 1000, messages)

    def list(self, args):
        count = integer(args, "last_messages", 3, 0, 5)
        return self.search(dict(args, query=""), recent_messages=count)

    def search(self, args, *, recent_messages=None):
        agents = select_agents(args)
        query = args.get("query", "").strip()
        if len(query) > 500:
            raise ValueError("query must be at most 500 characters")
        limit = integer(args, "limit", 10, 1, 30)
        offset = integer(args, "offset", 0, 0, 1000000)
        self.cache.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.cache.parent, 0o700)
        errors, seen = [], set()
        with closing(sqlite3.connect(self.cache, timeout=60)) as db, db:
            os.chmod(self.cache, 0o600)
            db.execute("CREATE TABLE IF NOT EXISTS records (source TEXT PRIMARY KEY, agent TEXT, stamp TEXT, data TEXT, search TEXT)")
            known = dict(db.execute("SELECT source,stamp FROM records"))
            for agent, key, stamp, source in self.sources(agents):
                seen.add(key)
                if known.get(key) == stamp:
                    continue
                try:
                    data = self.parse(agent, source)
                    haystack = "\n".join(str(data[k]) for k in ("session_id", "title", "cwd", "text")).casefold()
                    db.execute("INSERT OR REPLACE INTO records VALUES (?,?,?,?,?)", (key, agent, stamp, json.dumps(data, ensure_ascii=False), haystack))
                except (OSError, ValueError) as e:
                    # Never return an old cached version after a failed refresh.
                    db.execute("DELETE FROM records WHERE source=?", (key,))
                    errors.append(redact(str(e)))
            for key, agent in db.execute("SELECT source,agent FROM records").fetchall():
                if agent in agents and key not in seen:
                    db.execute("DELETE FROM records WHERE source=?", (key,))
            clauses = ["agent IN (" + ",".join("?" for _ in agents) + ")"]
            params = list(agents)
            for term in query.casefold().split():
                clauses.append("instr(search,?) > 0")
                params.append(term)
            if args.get("cwd"):
                clauses.append("instr(json_extract(data,'$.cwd'),?) > 0")
                params.append(args["cwd"])
            if args.get("exclude_session_id"):
                clauses.append("json_extract(data,'$.session_id') != ?")
                params.append(args["exclude_session_id"])
            where = " AND ".join(clauses)
            rows = db.execute(f"SELECT data FROM records WHERE {where} ORDER BY json_extract(data,'$.updated') DESC, source LIMIT ? OFFSET ?", params + [limit + 1, offset]).fetchall()
        results = []
        for (raw,) in rows[:limit]:
            data = json.loads(raw)
            text = data.pop("text")
            recent = data.pop("recent_messages")
            if recent_messages is not None:
                data["recent_messages"] = recent[-recent_messages:] if recent_messages else []
                results.append(data)
                continue
            # Casefold may change length; use the first matching original line for the snippet.
            line = next((l for l in text.splitlines() if any(t in l.casefold() for t in query.casefold().split())), text)
            terms = query.casefold().split()
            at = next((line.casefold().find(t) for t in terms if t in line.casefold()), 0)
            data["snippet"] = line[max(0, at - 100):max(0, at - 100) + 600]
            results.append(data)
        return dict(results=results, next_offset=offset + limit if len(rows) > limit else None,
                    warnings=errors[:10], failed_sources=len(errors), coverage=agents)

    def read(self, args):
        sid = args.get("session_id", "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}", sid):
            raise ValueError("session_id must be an exact ID, not a path or glob")
        matches = []
        for agent, _, _, source in self.sources(select_agents(args)):
            if agent != "opencode":
                # Native filenames end with the exact ID. No full search/index needed.
                if not source.stem.endswith(sid):
                    continue
                data = self.parse(agent, source)
            else:
                if source["id"] != sid:
                    continue
                data = self.parse(agent, source)
            if data["session_id"] == sid:
                matches.append(data)
        if not matches:
            raise ValueError("Session not found; use memory_search to discover an exact ID")
        if len(matches) != 1:
            raise ValueError("Ambiguous session ID; specify agent or remove duplicate session files")
        data = matches[0]
        data.pop("recent_messages")
        text = data.pop("text")
        version = hashlib.sha256(text.encode()).hexdigest()[:16]
        offset = integer(args, "offset", 0, 0, len(text))
        limit = integer(args, "limit", 12000, 1, 20000)
        if offset and args.get("version") != version:
            raise ValueError("Pagination requires the matching version from memory_read; restart at offset=0 if the session changed")
        end = min(len(text), offset + limit)
        return dict(data, text=text[offset:end], version=version, next_offset=end if end < len(text) else None,
                    total_chars=len(text), view="Raw user/assistant text; Pi last persisted branch, Codex/OpenCode/Claude Code stored history. Not reconstructed model context.")


def integer(args, key, default, low, high):
    value = args.get(key, default)
    if type(value) is not int or not low <= value <= high:
        raise ValueError(f"{key} must be an integer in [{low}, {high}]")
    return value


def select_agents(args):
    agent = args.get("agent", "all")
    if agent not in (*AGENTS, "all"):
        raise ValueError("agent must be pi, codex, opencode, claude, or all")
    return AGENTS if agent == "all" else (agent,)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        args = json.load(sys.stdin)
        memory = Memory()
        action = args.pop("action")
        if action not in ("list", "search", "read"):
            raise ValueError("Unknown action")
        print(json.dumps(getattr(memory, action)(args), ensure_ascii=False))
    except (OSError, ValueError, KeyError, sqlite3.Error) as error:
        print(json.dumps({"error": redact(str(error))}, ensure_ascii=False))
        sys.exit(1)
