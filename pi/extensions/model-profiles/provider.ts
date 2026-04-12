import { createAssistantMessageEventStream, streamSimple, type Context, type Model, type SimpleStreamOptions } from "@mariozechner/pi-ai";
import type { ProviderModelConfig } from "@mariozechner/pi-coding-agent";
import { expandRoleCandidates, getRoleTargets, resolveModelRole } from "./resolve";
import { streamWithModelRoleFallback } from "./runtime";
import {
	MODEL_PROFILES_PROVIDER,
	MODEL_PROFILES_PROVIDER_API,
	type ModelProfileConfig,
	type ModelProfilesConfig,
	type ModelRegistryLike,
	type ModelRoleConfigTarget,
} from "./types";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface SyntheticProfileModelSelection {
	profile: string;
	role: string;
}

function createErrorMessage(model: Model<any>, message: string) {
	return {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function normalizeConfigKey(value: string): string | undefined {
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function appendUniqueTarget(targets: ModelRoleConfigTarget[], target: ModelRoleConfigTarget): void {
	if (!target.provider || !target.model) return;
	if (targets.some((candidate) => candidate.provider === target.provider && candidate.model === target.model)) return;
	targets.push(target);
}

function collectRoleTargets(profile: ModelProfileConfig, roleName: string): ModelRoleConfigTarget[] {
	const trace: string[] = [];
	const orderedRoleNames = expandRoleCandidates(profile, roleName, trace);
	const targets: ModelRoleConfigTarget[] = [];
	for (const candidateRoleName of orderedRoleNames) {
		for (const target of getRoleTargets(profile.roles[candidateRoleName])) {
			appendUniqueTarget(targets, target);
		}
	}
	return targets;
}

function collectResolvedModels(targets: ModelRoleConfigTarget[], modelRegistry: ModelRegistryLike): Array<Model<any>> {
	const models: Array<Model<any>> = [];
	for (const target of targets) {
		if (!target.provider || !target.model) continue;
		const model = modelRegistry.find(target.provider, target.model);
		if (!model) continue;
		if (models.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) continue;
		models.push(model);
	}
	return models;
}

function intersectInputTypes(models: Array<Model<any>>): Array<"text" | "image"> {
	if (models.length === 0) return ["text"];
	const supported: Array<"text" | "image"> = ["text", "image"];
	const intersection = supported.filter((inputType) => models.every((model) => model.input.includes(inputType)));
	return intersection.length > 0 ? intersection : ["text"];
}

function buildSyntheticRoleModel(
	selection: SyntheticProfileModelSelection,
	profile: ModelProfileConfig,
	modelRegistry: ModelRegistryLike,
): ProviderModelConfig {
	const targets = collectRoleTargets(profile, selection.role);
	const resolvedModels = collectResolvedModels(targets, modelRegistry);
	const primaryModel = resolvedModels[0];
	const reasoning = resolvedModels.some((model) => model.reasoning)
		|| targets.some((target) => !!target.thinkingLevel && target.thinkingLevel !== "off");

	return {
		id: buildSyntheticProfileModelId(selection.profile, selection.role),
		name: `${selection.profile}:${selection.role}`,
		api: MODEL_PROFILES_PROVIDER_API,
		reasoning,
		input: intersectInputTypes(resolvedModels),
		cost: primaryModel?.cost ?? ZERO_COST,
		contextWindow: resolvedModels.length > 0
			? Math.min(...resolvedModels.map((model) => model.contextWindow))
			: DEFAULT_CONTEXT_WINDOW,
		maxTokens: resolvedModels.length > 0
			? Math.min(...resolvedModels.map((model) => model.maxTokens))
			: DEFAULT_MAX_TOKENS,
	};
}

export function buildSyntheticProfileModelId(profile: string, role: string): string {
	return `${profile}:${role}`;
}

export function parseSyntheticProfileModelId(id: string): SyntheticProfileModelSelection | null {
	const separatorIndex = id.indexOf(":");
	if (separatorIndex <= 0 || separatorIndex >= id.length - 1) return null;
	const profile = normalizeConfigKey(id.slice(0, separatorIndex));
	const role = normalizeConfigKey(id.slice(separatorIndex + 1));
	if (!profile || !role) return null;
	return { profile, role };
}

export function isSyntheticProfileModel(model: Pick<Model<any>, "provider" | "id"> | undefined): boolean {
	if (!model) return false;
	if (model.provider !== MODEL_PROFILES_PROVIDER) return false;
	return parseSyntheticProfileModelId(model.id) !== null;
}

export function buildSyntheticProfileProviderModels(
	config: ModelProfilesConfig,
	modelRegistry: ModelRegistryLike,
): ProviderModelConfig[] {
	const models: ProviderModelConfig[] = [];

	for (const profileName of Object.keys(config.profiles).sort((a, b) => a.localeCompare(b))) {
		const profile = config.profiles[profileName];
		for (const roleName of Object.keys(profile.roles).sort((a, b) => a.localeCompare(b))) {
			models.push(buildSyntheticRoleModel({ profile: profileName, role: roleName }, profile, modelRegistry));
		}
	}

	return models;
}

export function createModelProfilesProviderStream(getState: () => {
	config: ModelProfilesConfig;
	modelRegistry?: ModelRegistryLike;
}) {
	return (model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
		const outer = createAssistantMessageEventStream();

		(async () => {
			const state = getState();
			const selection = parseSyntheticProfileModelId(model.id);
			if (!selection) {
				throw new Error(`Invalid synthetic profile model id: ${model.id}`);
			}
			if (!state.modelRegistry) {
				throw new Error("Model registry unavailable for synthetic profiles provider");
			}

			const resolved = await resolveModelRole({
				modelRegistry: state.modelRegistry,
				config: state.config,
				profile: { value: selection.profile, source: "session" },
				role: { value: selection.role, source: "session" },
				allowModelFallbacks: false,
			});
			if (!resolved) {
				throw new Error(`No configured model targets resolved for ${selection.profile}:${selection.role}`);
			}

			const realStream = streamWithModelRoleFallback({
				resolved,
				modelRegistry: state.modelRegistry,
				context,
				options,
				buildOptions: async (candidate, auth) => {
					const candidateOptions: SimpleStreamOptions = {
						...(options ?? {}),
						apiKey: auth.apiKey,
						headers: {
							...(options?.headers ?? {}),
							...(auth.headers ?? {}),
						},
					};
					if (candidate.ref.thinkingLevel && candidate.ref.thinkingLevel !== "off") {
						candidateOptions.reasoning = candidate.ref.thinkingLevel;
					} else {
						delete candidateOptions.reasoning;
					}
					if (candidate.model.provider === "openai-codex") {
						delete candidateOptions.temperature;
					}
					return candidateOptions;
				},
				streamFn: streamSimple,
			});

			for await (const event of realStream) {
				outer.push(event);
			}
			outer.end();
		})().catch((error) => {
			outer.push({
				type: "error",
				reason: "error",
				error: createErrorMessage(model, error instanceof Error ? error.message : String(error)),
			});
			outer.end();
		});

		return outer;
	};
}
