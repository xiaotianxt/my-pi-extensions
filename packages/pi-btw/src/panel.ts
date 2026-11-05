import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class AnswerPanel implements Component {
  private markdown = new Markdown("", 0, 0, getMarkdownTheme());
  private offset = 0;
  private maxOffset = 0;
  private pageHeight = 1;
  private answer = "";
  private status = "Connecting…";
  private error = "";
  private readonly theme: Pick<Theme, "fg" | "bg" | "bold">;
  private readonly question: string;
  private readonly notice: string;
  private readonly rows: () => number;
  private readonly redraw: () => void;
  private readonly close: () => void;

  constructor(options: {
    theme: Pick<Theme, "fg" | "bg" | "bold">; question: string; notice: string;
    rows: () => number; redraw: () => void; close: () => void;
  }) {
    this.theme = options.theme;
    this.question = options.question;
    this.notice = options.notice;
    this.rows = options.rows;
    this.redraw = options.redraw;
    this.close = options.close;
    this.update();
  }

  setAnswer(text: string): void {
    this.answer = text;
    this.status = "Answering…";
    this.update();
  }

  finish(status: string): void { this.status = status; this.update(); }
  fail(message: string): void { this.status = "Error"; this.error = message; this.update(); }

  private update(): void {
    this.markdown.setText(this.answer || "Waiting for the model…");
    this.redraw();
  }

  render(width: number): string[] {
    if (width < 1) return [];
    const maxRows = Math.max(1, Math.floor(this.rows() * 0.8));
    // A full-width surface masks complete transcript rows, not just their middle.
    // Keep prose bounded independently so a wide terminal doesn't stretch it.
    const framed = width >= 8 && maxRows >= 7;
    const innerWidth = framed ? Math.min(96, width - 4) : width;
    const body = [
      ...new Text(this.theme.bold(this.question), 0, 0).render(innerWidth), "",
      ...this.markdown.render(innerWidth),
      ...(this.error ? ["", ...new Text(this.theme.fg("error", this.error), 0, 0).render(innerWidth)] : []),
      "", ...new Text(this.theme.fg("dim", this.notice), 0, 0).render(innerWidth),
    ];
    this.pageHeight = Math.min(Math.max(5, body.length), Math.max(1, maxRows - (framed ? 6 : 0)));
    this.maxOffset = Math.max(0, body.length - this.pageHeight);
    this.offset = Math.min(this.offset, this.maxOffset);
    const viewport = body.slice(this.offset, this.offset + this.pageHeight);
    const paint = (lines: string[]): string[] => {
      const surface = new Box(0, 0, (text) => this.theme.bg("customMessageBg", text));
      surface.addChild({ render: () => lines, invalidate() {} });
      return surface.render(width);
    };
    if (!framed) return paint(viewport.map((line) => truncateToWidth(line, width)));

    const left = 1;
    const right = width - innerWidth - 2 - left;
    const edge = this.theme.fg("border", "│");
    const row = (line: string) => {
      const content = truncateToWidth(line, innerWidth);
      return edge + " ".repeat(left) + content + " ".repeat(innerWidth - visibleWidth(content) + right) + edge;
    };
    const border = (start: string, end: string) => this.theme.fg("border", start + "─".repeat(width - 2) + end);
    const help = innerWidth < 60 ? "↑↓ scroll · Esc close" : "↑↓ / PgUp PgDn scroll · Enter / Esc close";
    const position = this.maxOffset ? `${this.offset + 1}–${this.offset + viewport.length}/${body.length} · ` : "";
    return paint([
      border("┌", "┐"),
      row(this.theme.fg(this.error ? "error" : "accent", `/btw · ${this.status}`)),
      row(""),
      ...viewport.map(row),
      ...Array.from({ length: this.pageHeight - viewport.length }, () => row("")),
      row(""),
      row(this.theme.fg("dim", position + help)),
      border("└", "┘"),
    ]);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    const page = this.pageHeight;
    if (matchesKey(data, "up")) this.offset = Math.max(0, this.offset - 1);
    if (matchesKey(data, "down")) this.offset = Math.min(this.maxOffset, this.offset + 1);
    if (matchesKey(data, "pageUp")) this.offset = Math.max(0, this.offset - page);
    if (matchesKey(data, "pageDown")) this.offset = Math.min(this.maxOffset, this.offset + page);
    if (matchesKey(data, "home")) this.offset = 0;
    if (matchesKey(data, "end")) this.offset = this.maxOffset;
    this.redraw();
  }

  invalidate(): void {
    this.markdown = new Markdown(this.answer || "Waiting for the model…", 0, 0, getMarkdownTheme());
  }
}
