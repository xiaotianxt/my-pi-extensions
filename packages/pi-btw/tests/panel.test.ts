import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AnswerPanel } from "../src/panel.ts";

initTheme("dark", false);
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[48;5;235m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const panel = (rows: () => number) => new AnswerPanel({
  theme, question: "你好", notice: "MODEL · Text snapshot · Older history omitted; first retained record may be partial",
  rows, redraw() {}, close() {},
});

test("short answers precede metadata and every framed row fills the declared width", () => {
  const view = panel(() => 35);
  view.setAnswer("你好！有什么我能帮你的？");
  for (const width of [32, 80, 175]) {
    const rendered = view.render(width);
    const text = rendered.map(stripVTControlCharacters);
    assert.ok(rendered.every((line) => visibleWidth(line) === width));
    assert.ok(text[0].startsWith("┌") && text[0].endsWith("┐"));
    assert.ok(text.at(-1)?.startsWith("└") && text.at(-1)?.endsWith("┘"));
    assert.ok(text.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
    assert.ok(text[1].startsWith("│ /btw"));
    assert.ok(text.some((line) => line.startsWith("│ 你好！")));
    assert.ok(text.some((line) => line.startsWith("│ MODEL")));
    assert.ok(text.findIndex((line) => line.includes("你好！")) < text.findIndex((line) => line.includes("MODEL")));
    assert.ok(rendered.every((line) => line.includes("\x1b[48;5;235m")));
    assert.ok(rendered.length <= Math.floor(35 * 0.8));
  }
});

test("long CJK/code answers scroll without losing the frame or overflowing after resize", () => {
  let rows = 24;
  const view = panel(() => rows);
  view.setAnswer("中文内容 ".repeat(300) + '\n\n```json\n{"command":"' + "x".repeat(200) + '"}\n```');
  for (const [width, height] of [[100, 24], [28, 12], [8, 9], [4, 4], [1, 2]]) {
    rows = height;
    const rendered = view.render(width);
    assert.ok(rendered.every((line) => visibleWidth(line) === width));
    assert.ok(rendered.length <= Math.max(1, Math.floor(height * 0.8)));
  }
  rows = 24;
  view.render(80);
  view.handleInput("\x1b[F"); // End
  const lastPage = view.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(lastPage, /MODEL/);
  assert.match(lastPage, /Esc close/);
  view.handleInput("\x1b[H"); // Home
  assert.match(view.render(80).map(stripVTControlCharacters).join("\n"), /你好/);
});
