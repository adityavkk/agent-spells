import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RENDER_CONFIG_FILENAME = "render.json";

export interface RenderModelSelectionConfig {
	profile?: string;
	role?: string;
	rolesByProfile?: Record<string, string>;
	roleCandidates?: string[];
	useActiveProfile?: boolean;
	fallbackToActiveRole?: boolean;
	fallbackToDefaultRole?: boolean;
}

export interface RenderConfig {
	modelSelection: RenderModelSelectionConfig;
}

export interface RenderConfigError {
	path: string;
	message: string;
}

export interface LoadedRenderConfig {
	globalPath: string;
	projectPath: string;
	globalConfig: RenderConfig;
	projectConfig: RenderConfig;
	mergedConfig: RenderConfig;
	errors: RenderConfigError[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const normalized: Record<string, string> = {};
	for (const [key, rawValue] of Object.entries(value)) {
		const normalizedKey = normalizeString(key);
		const normalizedValue = normalizeString(rawValue);
		if (!normalizedKey || !normalizedValue) continue;
		normalized[normalizedKey] = normalizedValue;
	}
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const item of value) {
		const role = normalizeString(item);
		if (!role || seen.has(role)) continue;
		seen.add(role);
		normalized.push(role);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeModelSelectionConfig(value: unknown): RenderModelSelectionConfig {
	if (!isRecord(value)) return {};
	return {
		profile: normalizeString(value.profile),
		role: normalizeString(value.role),
		rolesByProfile: normalizeStringMap(value.rolesByProfile),
		roleCandidates: normalizeStringArray(value.roleCandidates),
		useActiveProfile: normalizeBoolean(value.useActiveProfile),
		fallbackToActiveRole: normalizeBoolean(value.fallbackToActiveRole),
		fallbackToDefaultRole: normalizeBoolean(value.fallbackToDefaultRole),
	};
}

export function normalizeRenderConfig(value: unknown): RenderConfig {
	if (!isRecord(value)) return { modelSelection: {} };
	return {
		modelSelection: normalizeModelSelectionConfig(value.modelSelection),
	};
}

export function mergeRenderConfig(base: RenderConfig, override: RenderConfig): RenderConfig {
	return {
		modelSelection: {
			profile: override.modelSelection.profile ?? base.modelSelection.profile,
			role: override.modelSelection.role ?? base.modelSelection.role,
			rolesByProfile: {
				...(base.modelSelection.rolesByProfile ?? {}),
				...(override.modelSelection.rolesByProfile ?? {}),
			},
			roleCandidates: override.modelSelection.roleCandidates ?? base.modelSelection.roleCandidates,
			useActiveProfile: override.modelSelection.useActiveProfile ?? base.modelSelection.useActiveProfile,
			fallbackToActiveRole: override.modelSelection.fallbackToActiveRole ?? base.modelSelection.fallbackToActiveRole,
			fallbackToDefaultRole: override.modelSelection.fallbackToDefaultRole ?? base.modelSelection.fallbackToDefaultRole,
		},
	};
}

export function getGlobalRenderConfigPath(agentDir = join(homedir(), ".pi", "agent")): string {
	return join(agentDir, RENDER_CONFIG_FILENAME);
}

export function getProjectRenderConfigPath(cwd: string): string {
	return join(cwd, ".pi", RENDER_CONFIG_FILENAME);
}

function readConfigFile(path: string, errors: RenderConfigError[]): RenderConfig {
	if (!existsSync(path)) return { modelSelection: {} };
	try {
		return normalizeRenderConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		errors.push({
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		return { modelSelection: {} };
	}
}

export function loadRenderConfig(cwd: string, agentDir?: string): LoadedRenderConfig {
	const errors: RenderConfigError[] = [];
	const globalPath = getGlobalRenderConfigPath(agentDir);
	const projectPath = getProjectRenderConfigPath(cwd);
	const globalConfig = readConfigFile(globalPath, errors);
	const projectConfig = readConfigFile(projectPath, errors);
	return {
		globalPath,
		projectPath,
		globalConfig,
		projectConfig,
		mergedConfig: mergeRenderConfig(globalConfig, projectConfig),
		errors,
	};
}
