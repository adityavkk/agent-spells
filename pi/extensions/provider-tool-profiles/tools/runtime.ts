import { createReadHistory, type ReadHistory } from "./read-history";

export interface ProviderToolRuntime {
	readHistory: ReadHistory;
}

export function createProviderToolRuntime(): ProviderToolRuntime {
	return { readHistory: createReadHistory() };
}
