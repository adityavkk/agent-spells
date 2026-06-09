import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ModelRegistryLike } from "./types";

export type ModelRegistryFactory = () => ModelRegistryLike;

export interface LazyModelRegistryResolver {
	get(): ModelRegistryLike | undefined;
	getError(): unknown;
	reset(): void;
}

export function createFileBackedModelRegistry(): ModelRegistryLike {
	return ModelRegistry.create(AuthStorage.create()) as ModelRegistryLike;
}

export function createLazyModelRegistryResolver(factory: ModelRegistryFactory): LazyModelRegistryResolver {
	let modelRegistry: ModelRegistryLike | undefined;
	let error: unknown;

	return {
		get() {
			if (modelRegistry) return modelRegistry;
			try {
				modelRegistry = factory();
				error = undefined;
				return modelRegistry;
			} catch (caught) {
				error = caught;
				return undefined;
			}
		},
		getError() {
			return error;
		},
		reset() {
			modelRegistry = undefined;
			error = undefined;
		},
	};
}

export function formatModelRegistryUnavailableMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return detail
		? `Unable to resolve model profile targets: no model registry is available, and fallback registry creation failed: ${detail}`
		: "Unable to resolve model profile targets: no model registry is available";
}
