import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	loadModelProfilesConfig,
	normalizeModelProfilesState,
} from "./config";
import { readModelProfilesState, resolveModelRole } from "./resolve";
import { formatModelProfilesStateSummary, formatModelProfilesStatus, formatResolvedRoleSummary } from "./state";
import { createModelProfilesFooter } from "./ui";
import {
	MODEL_PROFILES_STATE_CUSTOM_TYPE,
	type LoadedModelProfilesConfig,
	type ModelProfilesSelection,
	type ModelProfilesState,
	type ResolvedRoleResult,
} from "./types";

const STATUS_KEY = "model-profiles";

function modelLabel(model: Model<any> | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

function getFlagString(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export default function modelProfilesExtension(pi: ExtensionAPI) {
	let loadedConfig: LoadedModelProfilesConfig = loadModelProfilesConfig(process.cwd());
	let activeState: ModelProfilesState = {};
	let lastResolved: ResolvedRoleResult | null = null;
	let unresolved = false;
	let currentModel: Model<any> | undefined;
	let latestCtx: ExtensionContext | undefined;

	function refreshConfig(cwd: string): void {
		loadedConfig = loadModelProfilesConfig(cwd);
	}

	function setActiveState(nextState: ModelProfilesState, persist = true): void {
		activeState = normalizeModelProfilesState(nextState);
		if (persist) {
			pi.appendEntry(MODEL_PROFILES_STATE_CUSTOM_TYPE, activeState);
		}
	}

	function currentStatusText(ctx: ExtensionContext): string | undefined {
		return formatModelProfilesStatus({
			state: activeState,
			resolved: lastResolved,
			currentModel: currentModel ?? ctx.model,
			unresolved,
		});
	}

	function updateStatus(ctx: ExtensionContext): void {
		latestCtx = ctx;
		ctx.ui.setStatus(STATUS_KEY, currentStatusText(ctx));
	}

	function notifyConfigErrors(ctx: ExtensionContext): void {
		for (const error of loadedConfig.errors) {
			ctx.ui.notify(`model-profiles config error: ${error.path}: ${error.message}`, "warning");
		}
	}

	function getProfileNames(): string[] {
		return uniqueSorted(Object.keys(loadedConfig.mergedConfig.profiles));
	}

	function getRoleNames(profileName: string | undefined): string[] {
		if (!profileName) return [];
		const profile = loadedConfig.mergedConfig.profiles[profileName];
		if (!profile) return [];
		return uniqueSorted(Object.keys(profile.roles));
	}

	function getEffectiveProfileName(): string | undefined {
		return activeState.activeProfile ?? loadedConfig.mergedConfig.activeProfile;
	}

	function buildProfileCommandSelection(profileName: string): { profile: ModelProfilesSelection; role?: ModelProfilesSelection; clearRole: boolean } {
		const profile = loadedConfig.mergedConfig.profiles[profileName];
		if (!profile) {
			return { profile: { value: profileName, source: "session" }, clearRole: false };
		}
		if (profile.defaultRole) {
			return {
				profile: { value: profileName, source: "session" },
				role: { value: profile.defaultRole, source: "config" },
				clearRole: false,
			};
		}
		if (activeState.activeRole && profile.roles[activeState.activeRole]) {
			return {
				profile: { value: profileName, source: "session" },
				role: { value: activeState.activeRole, source: "session" },
				clearRole: false,
			};
		}
		return { profile: { value: profileName, source: "session" }, clearRole: true };
	}

	async function applySelection(
		ctx: ExtensionContext,
		selections: { profile?: ModelProfilesSelection; role?: ModelProfilesSelection; clearRole?: boolean },
		options: { notify?: boolean; persist?: boolean } = {},
	): Promise<boolean> {
		refreshConfig(ctx.cwd);
		currentModel = ctx.model;

		const nextState: ModelProfilesState = {
			activeProfile: selections.profile?.value ?? activeState.activeProfile,
			activeRole: selections.clearRole ? undefined : selections.role?.value ?? activeState.activeRole,
		};
		const resolved = await resolveModelRole({
			modelRegistry: ctx.modelRegistry,
			config: loadedConfig.mergedConfig,
			state: nextState,
			currentModel: currentModel ?? ctx.model,
			profile: selections.profile,
			role: selections.role,
		});

		setActiveState({
			activeProfile: nextState.activeProfile ?? resolved?.profile,
			activeRole: nextState.activeRole ?? resolved?.role,
		}, options.persist ?? true);
		lastResolved = resolved;
		unresolved = !!activeState.activeRole && (!resolved || resolved.source === "current-model" || resolved.source === "first-available");

		if (loadedConfig.errors.length > 0 && options.notify !== false) {
			notifyConfigErrors(ctx);
		}

		if (!resolved) {
			updateStatus(ctx);
			if (options.notify !== false) {
				ctx.ui.notify("No model could be resolved for current profile/role state", "warning");
			}
			return false;
		}

		const changedModel = modelLabel(ctx.model) !== modelLabel(resolved.model);
		if (changedModel) {
			const success = await pi.setModel(resolved.model);
			if (!success) {
				updateStatus(ctx);
				if (options.notify !== false) {
					ctx.ui.notify(`No auth for ${resolved.ref.provider}/${resolved.ref.model}`, "warning");
				}
				return false;
			}
		}
		if (resolved.thinkingLevel) {
			pi.setThinkingLevel(resolved.thinkingLevel);
		}

		currentModel = resolved.model;
		updateStatus(ctx);
		if (options.notify !== false) {
			if (unresolved) {
				ctx.ui.notify(
					`Role "${activeState.activeRole}" unavailable; using ${resolved.ref.provider}/${resolved.ref.model}`,
					"warning",
				);
			} else if (selections.profile?.value && !selections.role?.value) {
				ctx.ui.notify(`Profile "${activeState.activeProfile}" activated`, "info");
			}
			ctx.ui.notify(`Role "${activeState.activeRole ?? resolved.role ?? "(none)"}" -> ${formatResolvedRoleSummary(resolved)}`, "info");
		}
		return true;
	}

	async function selectProfile(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const profileNames = getProfileNames();
		if (profileNames.length === 0) {
			ctx.ui.notify("No model profiles configured. Create ~/.pi/agent/model-profiles.json or .pi/model-profiles.json", "warning");
			return undefined;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/profile requires an argument outside interactive mode", "warning");
			return undefined;
		}
		return ctx.ui.select("Select profile", profileNames);
	}

	async function selectRole(ctx: ExtensionCommandContext, profileName: string): Promise<string | undefined> {
		const roleNames = getRoleNames(profileName);
		if (roleNames.length === 0) {
			ctx.ui.notify(`Profile "${profileName}" has no roles`, "warning");
			return undefined;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("/role requires an argument outside interactive mode", "warning");
			return undefined;
		}
		return ctx.ui.select(`Select role for ${profileName}`, roleNames);
	}

	pi.registerFlag("profile", {
		description: "Model profile to activate",
		type: "string",
	});
	pi.registerFlag("role", {
		description: "Model role to activate",
		type: "string",
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		refreshConfig(ctx.cwd);
		activeState = readModelProfilesState(ctx.sessionManager.getBranch());
		currentModel = ctx.model;
		ctx.ui.setFooter((_tui, theme, footerData) => createModelProfilesFooter(theme, footerData, () => ({
			ctx: latestCtx,
			model: currentModel ?? latestCtx?.model,
			thinkingLevel: pi.getThinkingLevel(),
			statusText: latestCtx ? currentStatusText(latestCtx) : undefined,
		})));
		if (loadedConfig.errors.length > 0 && ctx.hasUI) {
			notifyConfigErrors(ctx);
		}

		const profileFlag = getFlagString(pi, "profile");
		const roleFlag = getFlagString(pi, "role");
		const shouldResolve = !!profileFlag || !!roleFlag || !!activeState.activeProfile || !!activeState.activeRole || !!loadedConfig.mergedConfig.activeProfile;
		if (shouldResolve) {
			await applySelection(ctx, {
				profile: profileFlag ? { value: profileFlag, source: "flag" } : undefined,
				role: roleFlag ? { value: roleFlag, source: "flag" } : undefined,
			}, { notify: false, persist: false });
		}
		updateStatus(ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		latestCtx = ctx;
		currentModel = event.model;
		updateStatus(ctx);
	});

	pi.registerCommand("profile", {
		description: "Select or activate a model profile",
		handler: async (args, ctx) => {
			refreshConfig(ctx.cwd);
			const requestedProfile = args.trim() || await selectProfile(ctx);
			if (!requestedProfile) return;
			if (!loadedConfig.mergedConfig.profiles[requestedProfile]) {
				ctx.ui.notify(`Unknown profile "${requestedProfile}"`, "warning");
				return;
			}
			await applySelection(ctx, buildProfileCommandSelection(requestedProfile));
		},
	});

	pi.registerCommand("role", {
		description: "Select or activate a model role",
		handler: async (args, ctx) => {
			refreshConfig(ctx.cwd);
			const profileName = getEffectiveProfileName();
			if (!profileName) {
				ctx.ui.notify("No active profile. Use /profile first or set activeProfile in config", "warning");
				return;
			}
			const requestedRole = args.trim() || await selectRole(ctx, profileName);
			if (!requestedRole) return;
			if (!loadedConfig.mergedConfig.profiles[profileName]?.roles[requestedRole]) {
				ctx.ui.notify(`Unknown role "${requestedRole}" in profile "${profileName}"`, "warning");
				return;
			}
			await applySelection(ctx, {
				profile: { value: profileName, source: "session" },
				role: { value: requestedRole, source: "session" },
			});
		},
	});

	pi.registerCommand("model-profiles", {
		description: "Inspect, reload, or interactively select model profiles",
		handler: async (args, ctx) => {
			const subcommand = args.trim();
			refreshConfig(ctx.cwd);
			if (subcommand === "reload") {
				refreshConfig(ctx.cwd);
				if (loadedConfig.errors.length > 0) notifyConfigErrors(ctx);
				updateStatus(ctx);
				ctx.ui.notify("Model profiles reloaded", "info");
				return;
			}
			if (subcommand === "status") {
				ctx.ui.notify(formatModelProfilesStateSummary({
					state: activeState,
					resolved: lastResolved,
					currentModel: currentModel ?? ctx.model,
					unresolved,
				}), "info");
				return;
			}

			const requestedProfile = await selectProfile(ctx);
			if (!requestedProfile) return;
			const selection = buildProfileCommandSelection(requestedProfile);
			if (selection.clearRole) {
				await applySelection(ctx, selection);
				return;
			}
			const requestedRole = await selectRole(ctx, requestedProfile);
			if (!requestedRole) {
				await applySelection(ctx, selection);
				return;
			}
			await applySelection(ctx, {
				profile: { value: requestedProfile, source: "session" },
				role: { value: requestedRole, source: "session" },
			});
		},
	});
}
