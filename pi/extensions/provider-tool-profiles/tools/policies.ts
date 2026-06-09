export type ProviderProfile = "claude" | "codex" | "gemini";

export type ReadTextFormat = "plain" | "cat-n";

export interface ReadPolicy {
	offsetBase: 0 | 1;
	textFormat: ReadTextFormat;
	maxLines: number;
	maxBytes: number;
}

export interface ReadManyPolicy {
	maxFiles: number;
	maxBytes: number;
	defaultExcludes: readonly string[];
}

export interface ProviderPolicy {
	profile: ProviderProfile;
	read: ReadPolicy;
	readMany: ReadManyPolicy;
}

const DEFAULT_READ_MAX_LINES = 2000;
const DEFAULT_READ_MAX_BYTES = 50 * 1024;

export const CLAUDE_POLICY: ProviderPolicy = {
	profile: "claude",
	read: {
		offsetBase: 1,
		textFormat: "cat-n",
		maxLines: DEFAULT_READ_MAX_LINES,
		maxBytes: DEFAULT_READ_MAX_BYTES,
	},
	readMany: {
		maxFiles: 200,
		maxBytes: 512 * 1024,
		defaultExcludes: ["node_modules/**", ".git/**", "dist/**", "coverage/**"],
	},
};

export const GEMINI_POLICY: ProviderPolicy = {
	profile: "gemini",
	read: {
		offsetBase: 0,
		textFormat: "plain",
		maxLines: DEFAULT_READ_MAX_LINES,
		maxBytes: DEFAULT_READ_MAX_BYTES,
	},
	readMany: {
		maxFiles: 100,
		maxBytes: 512 * 1024,
		defaultExcludes: ["node_modules/**", ".git/**", "dist/**", "coverage/**"],
	},
};

export function policyForProfile(profile: "claude" | "gemini"): ProviderPolicy {
	return profile === "claude" ? CLAUDE_POLICY : GEMINI_POLICY;
}
