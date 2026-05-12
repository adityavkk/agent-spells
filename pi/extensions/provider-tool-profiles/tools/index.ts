import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerClaudeTools } from "./claude";
import { registerCodexTools } from "./codex";
import { registerGeminiTools } from "./gemini";

export function registerProviderToolProfileTools(pi: ExtensionAPI): void {
	registerClaudeTools(pi);
	registerCodexTools(pi);
	registerGeminiTools(pi);
}

