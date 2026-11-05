import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Herdr's managed integration exposes this event for companion hooks. Do not
// modify its installed file: Herdr overwrites that file during integration updates.
export default function (pi: ExtensionAPI) {
  let active = false;
  let blocked = false;
  function clear() {
    if (!blocked) return;
    blocked = false;
    pi.events.emit("herdr:blocked", { active: false });
  }
  pi.on("session_start", (_event, ctx) => {
    active = ctx.mode === "tui" && process.env.HERDR_ENV === "1";
  });
  pi.on("ui_prompt_start", (event, ctx) => {
    // An idle slash-command dialog is not an agent waiting for user input.
    if (!active || blocked || ctx.isIdle()) return;
    blocked = true;
    pi.events.emit("herdr:blocked", { active: true, label: event.title || "Waiting for user" });
  });
  pi.on("ui_prompt_end", clear);
  pi.on("agent_settled", clear);
  pi.on("session_shutdown", () => { clear(); active = false; });
}
