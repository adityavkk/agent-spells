import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadProviderToolProfilesConfig } from "./config";
import { detectProviderToolProfile } from "./provider-detect";
import { buildProviderToolActivation, getProfilePromptAppendix, type ToolActivationState } from "./tool-activation";
import { PROVIDER_TOOL_PROFILES_STATUS_KEY, type LoadedProviderToolProfilesConfig, type ProviderToolProfile } from "./types";
import { registerClaudeTools } from "./tools/claude";
import { registerCodexTools } from "./tools/codex";
import { registerGeminiTools } from "./tools/gemini";

function status(profile: ProviderToolProfile | undefined): string | undefined {
	return profile ? `tools:${profile}` : undefined;
}

export default function providerToolProfilesExtension(pi: ExtensionAPI) {
	let loadedConfig: LoadedProviderToolProfilesConfig = loadProviderToolProfilesConfig(process.cwd());
	let activationState: ToolActivationState = {};
	let activeProfile: ProviderToolProfile | undefined;

	registerClaudeTools(pi);
	registerCodexTools(pi);
	registerGeminiTools(pi);

	function refreshConfig(cwd: string): void {
		loadedConfig = loadProviderToolProfilesConfig(cwd);
	}

	function syncTools(ctx: ExtensionContext, model = ctx.model): void {
		const profile = detectProviderToolProfile(model, loadedConfig.mergedConfig);
		const result = buildProviderToolActivation(pi.getActiveTools(), profile, loadedConfig.mergedConfig, activationState);
		activationState = result.state;
		activeProfile = result.profile;
		pi.setActiveTools(result.tools);
		ctx.ui.setStatus(PROVIDER_TOOL_PROFILES_STATUS_KEY, status(activeProfile));
	}

	function notifyConfigErrors(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		for (const error of loadedConfig.errors) {
			ctx.ui.notify(`provider-tool-profiles config error: ${error.path}: ${error.message}`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx.cwd);
		notifyConfigErrors(ctx);
		if (!loadedConfig.mergedConfig.enabled) {
			ctx.ui.setStatus(PROVIDER_TOOL_PROFILES_STATUS_KEY, undefined);
			return;
		}
		syncTools(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshConfig(ctx.cwd);
		if (!loadedConfig.mergedConfig.enabled) {
			ctx.ui.setStatus(PROVIDER_TOOL_PROFILES_STATUS_KEY, undefined);
			return;
		}
		syncTools(ctx, event.model);
	});

	pi.on("before_agent_start", async (event) => {
		const appendix = getProfilePromptAppendix(activeProfile);
		if (!appendix || event.systemPrompt.includes(appendix)) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${appendix}` };
	});
}
