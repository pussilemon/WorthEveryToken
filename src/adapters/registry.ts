import type { ProviderId, WetGlobalConfig } from "../config/schema.js";
import type { AgentAdapter } from "./agent-adapter.js";
import { ClaudeAdapter } from "./claude-adapter.js";
import { CodexAdapter } from "./codex-adapter.js";
import { AgyAdapter } from "./agy-adapter.js";
import { GeminiAdapter } from "./gemini-adapter.js";
import { CustomAdapter } from "./custom-adapter.js";

export function getAdapter(provider: ProviderId, config?: WetGlobalConfig): AgentAdapter {
  switch (provider) {
    case "claude": {
      return new ClaudeAdapter({
        defaultModel: config?.model_override && config.model_override !== "auto" ? config.model_override : undefined
      });
    }
    case "codex": {
      return new CodexAdapter({
        defaultModel: config?.model_override && config.model_override !== "auto" ? config.model_override : undefined
      });
    }
    case "agy": {
      return new AgyAdapter();
    }
    case "gemini": {
      return new GeminiAdapter({
        defaultModel: config?.model_override && config.model_override !== "auto" ? config.model_override : undefined
      });
    }
    case "custom": {
      return new CustomAdapter(config?.custom_provider);
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unsupported provider: ${_exhaustive}`);
    }
  }
}
