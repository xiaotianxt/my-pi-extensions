import { copyToClipboard, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type CodeBlock = { language: string; code: string };

function codeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let fence: string | undefined;
  let indent = 0;
  let language = "";
  let lines: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (!fence) {
      const opening = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (!opening || (opening[2][0] === "`" && opening[3].includes("`"))) continue;
      indent = opening[1].length;
      fence = opening[2];
      language = opening[3].trim().split(/\s+/)[0];
      lines = [];
      continue;
    }
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) {
      blocks.push({ language, code: lines.join("\n") });
      fence = undefined;
    } else {
      lines.push(line.replace(new RegExp(`^ {0,${indent}}`), ""));
    }
  }
  // Do not copy an unfinished block while a response is streaming.
  return blocks;
}

export default function (pi: ExtensionAPI) {
  const copyCode = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the response to finish before copying code.", "info");
      return;
    }
    let text = "";
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      text = entry.message.content
        .filter(part => part.type === "text")
        .map(part => part.text)
        .join("\n");
      break;
    }
    const blocks = codeBlocks(text);
    if (!blocks.length) {
      ctx.ui.notify("No complete code blocks in the latest assistant response.", "info");
      return;
    }
    let block = blocks[0];
    if (blocks.length > 1) {
      const labels = blocks.map((item, i) => {
        const preview = item.code.split("\n").find(line => line.trim())?.trim() ?? "(empty)";
        return `${i + 1}. ${item.language || "text"} · ${item.code.split("\n").length} lines · ${preview.slice(0, 90)}`;
      });
      const selected = await ctx.ui.select("Copy code block", labels);
      if (selected === undefined) return;
      block = blocks[labels.indexOf(selected)];
    }
    try {
      await copyToClipboard(block.code);
      ctx.ui.notify("Code block copied.", "info");
    } catch (error) {
      ctx.ui.notify(`Could not copy code: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };
  pi.registerCommand("copy-code", {
    description: "Copy a code block from the latest assistant response",
    handler: async (_args, ctx) => copyCode(ctx),
  });
  pi.registerShortcut("ctrl+alt+c", {
    description: "Copy assistant code block",
    handler: copyCode,
  });
}
