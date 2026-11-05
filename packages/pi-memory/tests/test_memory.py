import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from memory import Memory, parse_file, redact


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.memory = Memory(self.home)

    def session(self, agent, sid, entries):
        path = self.memory.roots[agent] / "workspace" / f"test_{sid}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        header = dict(type="session", version=3, id=sid, cwd="/work") if agent == "pi" else dict(type="session_meta", payload=dict(id=sid, cwd="/work"))
        path.write_text("\n".join(json.dumps(e) for e in [header, *entries]) + "\n")
        return path

    def message(self, key, parent, text, role="user"):
        return dict(type="message", id=key, parentId=parent, message=dict(role=role, content=text))

    def test_pi_branch_and_nonmessage_leaf(self):
        path = self.session("pi", "branch", [
            self.message("a", None, "root"), self.message("b", "a", "abandoned"),
            dict(type="branch_summary", id="c", parentId="a", fromId="b", summary="not a message"),
            self.message("d", "c", "chosen"),
            dict(type="session_info", id="e", parentId="d", name="Title"),
        ])
        result = parse_file("pi", path)
        self.assertIn("root", result["text"])
        self.assertIn("chosen", result["text"])
        self.assertNotIn("abandoned", result["text"])
        self.assertEqual(result["title"], "Title")
        self.assertIn("L5", result["text"])

    def test_codex_uses_canonical_messages_only(self):
        path = self.session("codex", "codex", [
            dict(type="event_msg", payload=dict(type="user_message", message="duplicate")),
            dict(type="response_item", payload=dict(type="message", role="user", content=[dict(type="input_text", text="actual")])),
            dict(type="response_item", payload=dict(type="message", role="assistant", content=[dict(type="output_text", text="reply")])),
            dict(type="event_msg", payload=dict(type="agent_message", message="reply")),
        ])
        text = parse_file("codex", path)["text"]
        self.assertEqual(text.count("reply"), 1)
        self.assertNotIn("duplicate", text)

    def test_search_literal_unicode_and_incremental_changes(self):
        path = self.session("pi", "search", [self.message("a", None, "家宽 100%_literal Alpha")])
        result = self.memory.search(dict(query="家宽 ALPHA %_", agent="pi"))
        self.assertEqual([r["session_id"] for r in result["results"]], ["search"])
        self.assertEqual(self.memory.cache.stat().st_mode & 0o777, 0o600)
        with path.open("a") as f:
            f.write(json.dumps(self.message("b", "a", "fresh")) + "\n")
        self.assertEqual(len(self.memory.search(dict(query="fresh"))["results"]), 1)
        path.unlink()
        self.assertEqual(self.memory.search(dict(query="fresh"))["results"], [])

    def test_pagination_is_lossless_and_detects_changed_history(self):
        path = self.session("pi", "pages", [self.message("a", None, "中文🙂" * 40)])
        args = dict(session_id="pages", limit=13)
        first = self.memory.read(args)
        page, chunks = first, []
        while True:
            chunks.append(page["text"])
            if page["next_offset"] is None:
                break
            page = self.memory.read(dict(args, offset=page["next_offset"], version=page["version"]))
        self.assertEqual("".join(chunks), parse_file("pi", path)["text"])
        with path.open("a") as f:
            f.write(json.dumps(self.message("b", "a", "changed")) + "\n")
        with self.assertRaisesRegex(ValueError, "Pagination"):
            self.memory.read(dict(args, offset=13, version=first["version"]))

    def test_truncated_tail_and_corruption_do_not_return_stale_cache(self):
        path = self.session("pi", "live", [self.message("a", None, "visible")])
        self.memory.search(dict(query="visible"))
        with path.open("a") as f:
            f.write('{"type":')
        self.assertIn("visible", self.memory.read(dict(session_id="live"))["text"])
        with path.open("a") as f:
            f.write("\n")
        result = self.memory.search(dict(query="visible"))
        self.assertEqual(result["results"], [])
        self.assertEqual(result["failed_sources"], 1)

    def test_tools_reasoning_and_common_secrets_are_excluded(self):
        path = self.session("pi", "private", [
            self.message("a", None, "api_key=abc123\nhello"),
            self.message("b", "a", "tool-private", "toolResult"),
            dict(type="message", id="c", parentId="b", message=dict(role="assistant", content=[dict(type="thinking", thinking="private"), dict(type="text", text="public")])),
        ])
        text = parse_file("pi", path)["text"]
        self.assertNotIn("abc123", text)
        self.assertNotIn("private", text)
        self.assertIn("public", text)
        self.assertNotIn("secret-material", redact("-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----"))

    def test_opencode_reads_part_text_and_refreshes_part_updates(self):
        path = self.memory.db_path
        path.parent.mkdir(parents=True)
        with sqlite3.connect(path) as db:
            db.executescript("""
                CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_updated INTEGER);
                CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
                CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
                INSERT INTO session VALUES('ses_test','Example','/work',1000);
                INSERT INTO message VALUES('msg','ses_test',1,1,'{"role":"assistant"}');
                INSERT INTO part VALUES('part','msg','ses_test',1,1,'{"type":"text","text":"original"}');
            """)
        self.assertEqual(len(self.memory.search(dict(query="original"))["results"]), 1)
        with sqlite3.connect(path) as db:
            db.execute("UPDATE part SET data=?,time_updated=2", (json.dumps(dict(type="text", text="updated")),))
        self.assertEqual(len(self.memory.search(dict(query="updated"))["results"]), 1)
        self.assertIn("updated", self.memory.read(dict(session_id="ses_test"))["text"])
        with sqlite3.connect(path) as db:
            db.execute("INSERT INTO part VALUES('part2','msg','ses_test',2,3,?)", (json.dumps(dict(type="text", text="second part")),))
        result = self.memory.list(dict(agent="opencode"))["results"][0]
        self.assertEqual(result["message_count"], 1)
        self.assertEqual([m["text"] for m in result["recent_messages"]], ["updated\nsecond part"])

    def test_native_sessions_not_subagent_transcript_exports(self):
        path = self.session("pi", "native", [self.message("a", None, "native")])
        exports = path.parent / "subagent-artifacts"
        exports.mkdir()
        (exports / "worker_transcript.jsonl").write_text('{"role":"user","content":"export"}\n')
        result = self.memory.search(dict(query="", agent="pi"))
        self.assertEqual(result["failed_sources"], 0)
        self.assertEqual([r["session_id"] for r in result["results"]], ["native"])

    def test_recent_search_pagination(self):
        for sid in ("first", "second", "third"):
            self.session("pi", sid, [self.message("a", None, sid)])
        first = self.memory.search(dict(query="", limit=2))
        second = self.memory.search(dict(query="", limit=2, offset=first["next_offset"]))
        ids = [r["session_id"] for r in first["results"] + second["results"]]
        self.assertEqual(set(ids), {"first", "second", "third"})
        self.assertEqual(len(ids), 3)
        self.assertIsNone(second["next_offset"])

    def test_legacy_linear_session_and_broken_branch(self):
        path = self.session("pi", "legacy", [self.message("a", None, "first"), self.message("b", None, "second")])
        path.write_text(path.read_text().replace('"version": 3', '"version": 1'))
        text = parse_file("pi", path)["text"]
        self.assertIn("first", text)
        self.assertIn("second", text)
        broken = self.session("pi", "broken", [self.message("a", "missing-parent", "orphan")])
        with self.assertRaisesRegex(ValueError, "Broken session branch"):
            parse_file("pi", broken)

    def test_list_returns_each_sessions_tail_and_pages_newest_first(self):
        for n, sid in enumerate(("older", "newer")):
            path = self.session("pi", sid, [self.message(str(i), str(i - 1) if i else None, f"{sid}-{i}", "assistant" if i % 2 else "user") for i in range(6)])
            os.utime(path, (100 + n, 100 + n))
        first = self.memory.list(dict(limit=1))
        result = first["results"][0]
        self.assertEqual(result["session_id"], "newer")
        self.assertEqual([m["text"] for m in result["recent_messages"]], ["newer-3", "newer-4", "newer-5"])
        self.assertEqual(result["message_count"], 6)
        self.assertNotIn("text", result)
        self.assertNotIn("snippet", result)
        second = self.memory.list(dict(limit=1, offset=first["next_offset"], last_messages=1))
        self.assertEqual(second["results"][0]["session_id"], "older")
        self.assertEqual(second["results"][0]["recent_messages"][0]["text"], "older-5")
        self.assertIsNone(second["next_offset"])
        self.assertEqual(self.memory.list(dict(cwd="unmatched"))["results"], [])

    def test_list_bounds_redaction_empty_sessions_and_dotted_ids(self):
        self.session("pi", "subagent.example", [self.message("a", None, "api_key=secretvalue\n" + "长" * 700)])
        self.session("pi", "empty", [])
        results = {r["session_id"]: r for r in self.memory.list({})["results"]}
        preview = results["subagent.example"]["recent_messages"][0]
        self.assertEqual(len(preview["text"]), 600)
        self.assertTrue(preview["truncated"])
        self.assertNotIn("secretvalue", preview["text"])
        self.assertEqual(results["empty"]["recent_messages"], [])
        self.assertTrue(all(not r["recent_messages"] for r in self.memory.list(dict(last_messages=0))["results"]))
        self.assertIn("长", self.memory.read(dict(session_id="subagent.example"))["text"])
        for count in (-1, 6, True):
            with self.assertRaises(ValueError):
                self.memory.list(dict(last_messages=count))

    def claude_session(self, entries, name="claude-session"):
        path = self.memory.roots["claude"] / "-work" / f"{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(e) + "\n" for e in entries))
        return path

    def test_claude_metadata_text_filters_and_tools(self):
        path = self.claude_session([
            dict(type="file-history-snapshot", snapshot={}),
            dict(type="custom-title", sessionId="claude-session", customTitle="Chosen title"),
            dict(type="user", sessionId="claude-session", cwd="/work/claude",
                 message=dict(role="user", content="你好 api_key=hiddenvalue")),
            dict(type="assistant", sessionId="claude-session", message=dict(role="assistant", content=[
                dict(type="thinking", thinking="private reasoning"),
                dict(type="tool_use", name="Bash", input=dict(command="private command")),
                dict(type="text", text="Visible answer")])),
            dict(type="user", message=dict(role="user", content=[dict(type="tool_result", content="private output")])),
            dict(type="user", isSidechain=True, message=dict(role="user", content="private sidechain")),
            dict(type="ai-title", sessionId="claude-session", aiTitle="Automatic title"),
        ])
        result = self.memory.list(dict(agent="claude"))["results"][0]
        self.assertEqual(result["title"], "Chosen title")
        self.assertEqual(result["cwd"], "/work/claude")
        self.assertEqual(result["message_count"], 2)
        self.assertEqual(result["recent_messages"][-1]["text"], "Visible answer")
        self.assertEqual(len(self.memory.search(dict(query="你好 visible", agent="claude"))["results"]), 1)
        text = self.memory.read(dict(session_id="claude-session", agent="claude"))["text"]
        self.assertIn("L3 user", text)
        self.assertNotIn("hiddenvalue", text)
        self.assertNotIn("private", text)
        with path.open("a") as f:
            f.write(json.dumps(dict(type="assistant", message=dict(role="assistant", content="Fresh reply"))) + "\n")
            f.write('{"type":')
        self.assertEqual(len(self.memory.search(dict(query="Fresh", agent="claude"))["results"]), 1)
        first = self.memory.read(dict(session_id="claude-session", limit=10))
        second = self.memory.read(dict(session_id="claude-session", offset=first["next_offset"], version=first["version"]))
        self.assertEqual(first["text"] + second["text"], parse_file("claude", path)["text"])
        path.unlink()
        self.assertEqual(self.memory.list(dict(agent="claude"))["results"], [])

    def test_claude_discovery_and_invalid_sources(self):
        entry = dict(type="user", sessionId="claude-session", message=dict(role="user", content="Main prompt"))
        path = self.claude_session([entry])
        self.claude_session([entry], "agent-legacy")
        nested = path.parent / "claude-session/subagents/agent-child.jsonl"
        nested.parent.mkdir(parents=True)
        nested.write_text(json.dumps(entry) + "\n")
        result = self.memory.list(dict(agent="claude"))
        self.assertEqual(len(result["results"]), 1)
        self.assertEqual(result["failed_sources"], 0)
        self.assertEqual(result["results"][0]["title"], "Main prompt")
        with path.open("a") as f:
            f.write(json.dumps(dict(type="user", sessionId="different")) + "\n")
        result = self.memory.list(dict(agent="claude"))
        self.assertEqual(result["results"], [])
        self.assertEqual(result["failed_sources"], 1)
        path.write_text('{"type":"file-history-snapshot"}\n')
        with self.assertRaisesRegex(ValueError, "Missing Claude session ID"):
            parse_file("claude", path)

    def test_validation_missing_and_exclusion(self):
        self.session("pi", "current", [self.message("a", None, "matching")])
        self.assertEqual(self.memory.search(dict(query="matching", exclude_session_id="current"))["results"], [])
        for sid in ("../escape", "*", "missing"):
            with self.assertRaises(ValueError):
                self.memory.read(dict(session_id=sid))
        with self.assertRaises(ValueError):
            self.memory.search(dict(query="", limit=0))


if __name__ == "__main__":
    unittest.main()
