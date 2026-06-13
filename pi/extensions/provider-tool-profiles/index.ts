import type { ExtensionAPI, ExtensionContext } from "./tools/pi-compat";
import { loadProviderToolProfilesConfig } from "./config";
import { detectProviderToolProfile } from "./provider-detect";
import { resolveProfileBackedModel } from "./profile-model-resolver";
import { applyProfilePromptAppendix, buildProviderToolActivation, type ToolActivationState } from "./tool-activation";
import { PROVIDER_TOOL_PROFILES_STATUS_KEY, type LoadedProviderToolProfilesConfig, type ProviderToolProfile } from "./types";
import { registerClaudeTools } from "./tools/claude";
import { registerCodexTools } from "./tools/codex";
import { registerGeminiTools } from "./tools/gemini";
import { createCodexPlanState } from "./tools/plan-state";
import { createProviderToolRuntime } from "./tools/runtime";

function status(profile: ProviderToolProfile | undefined): string | undefined {
	return profile ? `tools:${profile}` : undefined;
}

function isSubagentChild(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
}

export default function providerToolProfilesExtension(pi: ExtensionAPI) {
	let loadedConfig: LoadedProviderToolProfilesConfig = loadProviderToolProfilesConfig(process.cwd());
	let activationState: ToolActivationState = {};
	let activeProfile: ProviderToolProfile | undefined;
	let activeProfileTools: string[] = [];
	const runtime = createProviderToolRuntime();
	const codexPlanState = createCodexPlanState(pi);

	registerClaudeTools(pi, runtime);
	registerCodexTools(pi, codexPlanState);
	registerGeminiTools(pi, runtime);

	function refreshConfig(cwd: string): void {
		loadedConfig = loadProviderToolProfilesConfig(cwd);
	}

	async function syncTools(ctx: ExtensionContext, model = ctx.model): Promise<void> {
		const concreteModel = await resolveProfileBackedModel({
			cwd: ctx.cwd,
			model,
			modelRegistry: ctx.modelRegistry,
			entries: ctx.sessionManager.getBranch(),
		});
		const profile = detectProviderToolProfile(concreteModel, loadedConfig.mergedConfig);
		const result = buildProviderToolActivation(pi.getActiveTools(), profile, loadedConfig.mergedConfig, activationState);
		activationState = result.state;
		activeProfile = result.profile;
		activeProfileTools = result.profileTools;
		pi.setActiveTools(result.tools);
		ctx.ui.setStatus(PROVIDER_TOOL_PROFILES_STATUS_KEY, status(activeProfile));
	}

	// Restore the tool set captured before this extension activated a profile.
	// Only touches active tools when a profile is currently active, so disabling
	// the extension (or running inside a subagent child) reverts provider-native
	// tools instead of leaving them stranded, without clobbering a tool set this
	// extension never modified.
	function deactivateTools(ctx: ExtensionContext): void {
		if (activeProfile) {
			const result = buildProviderToolActivation(pi.getActiveTools(), undefined, loadedConfig.mergedConfig, activationState);
			activationState = result.state;
			activeProfile = result.profile;
			activeProfileTools = result.profileTools;
			pi.setActiveTools(result.tools);
		}
		ctx.ui.setStatus(PROVIDER_TOOL_PROFILES_STATUS_KEY, undefined);
	}

	function notifyConfigErrors(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		for (const error of loadedConfig.errors) {
			ctx.ui.notify(`provider-tool-profiles config error: ${error.path}: ${error.message}`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		runtime.readHistory.clear();
		codexPlanState.loadFromSession(ctx);
		refreshConfig(ctx.cwd);
		notifyConfigErrors(ctx);
		if (isSubagentChild() || !loadedConfig.mergedConfig.enabled) {
			deactivateTools(ctx);
			return;
		}
		await syncTools(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshConfig(ctx.cwd);
		if (isSubagentChild() || !loadedConfig.mergedConfig.enabled) {
			deactivateTools(ctx);
			return;
		}
		await syncTools(ctx, event.model);
	});

	pi.on("before_agent_start", async (event) => {
		const systemPrompt = applyProfilePromptAppendix(event.systemPrompt, activeProfile, activeProfileTools);
		if (systemPrompt === undefined) return;
		return { systemPrompt };
	});
}
