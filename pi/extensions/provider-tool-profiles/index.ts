import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadProviderToolProfilesConfig } from "./config";
import { PROFILE_PROMPTS } from "./profiles";
import { resolveProviderToolProfile } from "./provider-detect";
import { resolveActiveTools } from "./tool-activation";
import { registerProviderToolProfileTools } from "./tools";
import type { LoadedProviderToolProfilesConfig, ToolActivationState } from "./types";

const STATUS_KEY = "provider-tools";

export default function providerToolProfilesExtension(pi: ExtensionAPI): void {
	let loadedConfig: LoadedProviderToolProfilesConfig = loadProviderToolProfilesConfig(process.cwd());
	let activationState: ToolActivationState = {};

	registerProviderToolProfileTools(pi);

	function refreshConfig(ctx: ExtensionContext): void {
		loadedConfig = loadProviderToolProfilesConfig(ctx.cwd);
		for (const error of loadedConfig.errors) {
			ctx.ui.notify(`provider-tool-profiles config error: ${error.path}: ${error.message}`, "warning");
		}
	}

	async function syncTools(ctx: ExtensionContext, model = ctx.model): Promise<void> {
		const profile = resolveProviderToolProfile({ model, config: loadedConfig.mergedConfig });
		const resolved = resolveActiveTools({
			activeTools: pi.getActiveTools(),
			profile,
			config: loadedConfig.mergedConfig,
			state: activationState,
		});
		activationState = resolved.state;
		await pi.setActiveTools(resolved.tools);
		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, profile ? `tools:${profile}` : undefined);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig(ctx);
		await syncTools(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		refreshConfig(ctx);
		await syncTools(ctx, event.model);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const profile = activationState.lastProfile ?? resolveProviderToolProfile({
			model: ctx.model,
			config: loadedConfig.mergedConfig,
		});
		if (!profile) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PROFILE_PROMPTS[profile]}`,
		};
	});
}

