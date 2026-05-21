import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadModelProfilesConfig } from "../model-profiles/config";
import { parseSyntheticProfileModelId } from "../model-profiles/provider";
import { readModelProfilesState, resolveModelRole } from "../model-profiles/resolve";
import { getModelProfilesSelectionKey, readModelProfilesRuntimeState } from "../model-profiles/state";
import { MODEL_PROFILES_PROVIDER, type SessionEntryLike } from "../model-profiles/types";
import type { ModelLike } from "./types";

export interface ProfileModelResolverInput {
	cwd: string;
	model: ModelLike | undefined;
	modelRegistry: ExtensionContext["modelRegistry"];
	entries: ReadonlyArray<SessionEntryLike>;
}

function fallbackModel(provider: string | undefined, model: string | undefined): ModelLike | undefined {
	if (!provider || !model) return undefined;
	return { provider, id: model };
}

export async function resolveProfileBackedModel(input: ProfileModelResolverInput): Promise<ModelLike | undefined> {
	if (input.model?.provider !== MODEL_PROFILES_PROVIDER) return input.model;
	const synthetic = parseSyntheticProfileModelId(input.model.id ?? "");
	if (!synthetic) return input.model;

	const loaded = loadModelProfilesConfig(input.cwd);
	const state = readModelProfilesState(input.entries);
	const runtime = readModelProfilesRuntimeState(input.entries);
	const selectionKey = getModelProfilesSelectionKey(synthetic.profile, synthetic.role);
	const sticky = selectionKey ? runtime.selections[selectionKey] : undefined;

	const stickyWinner = fallbackModel(sticky?.lastWinner?.provider, sticky?.lastWinner?.model);
	if (stickyWinner) return stickyWinner;

	const resolved = await resolveModelRole({
		modelRegistry: input.modelRegistry,
		config: loaded.mergedConfig,
		state,
		profile: { value: synthetic.profile, source: "session" },
		role: { value: synthetic.role, source: "session" },
		allowModelFallbacks: false,
	});
	if (!resolved || resolved.candidates.length === 0) return input.model;

	const cursor = typeof sticky?.cursor === "number" ? sticky.cursor % resolved.candidates.length : 0;
	return resolved.candidates[cursor]?.model ?? resolved.model;
}
