import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSnapshot } from "./context.ts";
import { AnswerPanel } from "./panel.ts";
import { answerQuestion } from "./request.ts";

export default function btw(pi: ExtensionAPI): void {
  let active: { controller: AbortController; dismiss: () => void } | undefined;
  const dismiss = (): void => {
    active?.controller.abort();
    active?.dismiss();
  };
  pi.on("session_shutdown", dismiss);
  pi.on("session_tree", dismiss);

  pi.registerCommand("btw", {
    description: "Ask a read-only side question using a snapshot of the current branch",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/btw requires interactive terminal mode.", "error");
        return;
      }
      const question = args.trim();
      if (!question) { ctx.ui.notify("Usage: /btw <question>", "info"); return; }
      if (active) { ctx.ui.notify("Close the current /btw answer first.", "info"); return; }
      const model = ctx.model;
      if (!model) { ctx.ui.notify("Select a model first.", "error"); return; }
      let snapshot;
      try {
        // Entire snapshot is serialized before the first await. No mutable
        // session/provider message references escape into the background task.
        snapshot = buildSnapshot(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId(), question, model.contextWindow);
      } catch (error) {
        ctx.ui.notify(`Cannot build /btw context: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const registry = ctx.modelRegistry;
      const run = { controller: new AbortController(), dismiss: () => {} };
      active = run;
      try {
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          run.dismiss = () => { run.controller.abort(); done(); };
          const panel = new AnswerPanel({
            theme, question,
            notice: `${model.provider}/${model.id} · ${snapshot.notice}`,
            rows: () => tui.terminal.rows,
            redraw: () => tui.requestRender(),
            close: run.dismiss,
          });
          void Promise.resolve().then(async () => {
            if (run.controller.signal.aborted) { run.dismiss(); return; }
            try {
              const result = await answerQuestion({
                registry, model, context: snapshot.context, signal: run.controller.signal,
                onText: (text) => { if (!run.controller.signal.aborted) panel.setAnswer(text); },
              });
              if (!run.controller.signal.aborted) {
                const tokens = result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite;
                panel.finish(`${result.limited ? "Output limit reached" : "Done"} · ${tokens.toLocaleString()} tokens · $${result.usage.cost.total.toFixed(4)}`);
              }
            } catch (error) {
              if (!run.controller.signal.aborted) panel.fail(error instanceof Error ? error.message : String(error));
            }
          });
          return panel;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "80%", anchor: "center" } });
      } finally {
        run.controller.abort();
        if (active === run) active = undefined;
      }
    },
  });
}
