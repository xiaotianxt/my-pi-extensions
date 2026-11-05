import { randomUUID } from "node:crypto";
import { resolvePiCodexAuth } from "./pi-auth.js";
import type { SearchProviderFactory } from "./provider.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CodexWebSearchProvider } from "./codex-provider.js";
import { createResearchTool } from "./research-tool.js";
import { createSearchTool } from "./search-tool.js";
import { createLegacyWebTool } from "./legacy-web-tool.js";
import { registerSearchCommand } from "./search-command.js";

export default function (pi: ExtensionAPI) {
  const sessionId = randomUUID();
  const provider: SearchProviderFactory = (ctx) => new CodexWebSearchProvider({
    sessionId,
    resolveAuth: () => resolvePiCodexAuth(ctx),
  });

  // Register codex-research harness tool
  pi.registerTool(createResearchTool(provider));

  // Register codex-search single-query wrapper
  pi.registerTool(createSearchTool(provider));

  // Register legacy `web` alias (deprecated, delegates to codex-research)
  pi.registerTool(createLegacyWebTool(provider));

  // Register /gpt-search slash command
  registerSearchCommand(pi, provider);
}
