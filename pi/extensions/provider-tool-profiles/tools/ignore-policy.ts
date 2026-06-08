import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export type IgnoreSource = "explicit" | "gemini" | "git";

export interface IgnoreRule {
	pattern: string;
	source: IgnoreSource;
	negated: boolean;
	directoryOnly: boolean;
}

export interface IgnoreRuleSet {
	rules: IgnoreRule[];
	unsupportedNegations: number;
}

export function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function parseIgnorePatterns(source: IgnoreSource, patterns: readonly string[] | undefined): IgnoreRuleSet {
	const rules: IgnoreRule[] = [];
	let unsupportedNegations = 0;
	for (const raw of patterns ?? []) {
		const trimmed = raw.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const negated = trimmed.startsWith("!");
		if (negated) unsupportedNegations += 1;
		const body = negated ? trimmed.slice(1).trim() : trimmed;
		if (!body) continue;
		const normalized = toPosixPath(body).replace(/^\//, "");
		rules.push({
			pattern: normalized.replace(/\/$/, ""),
			source,
			negated,
			directoryOnly: normalized.endsWith("/"),
		});
	}
	return { rules, unsupportedNegations };
}

export async function loadIgnoreFile(cwd: string, fileName: ".geminiignore" | ".gitignore", source: IgnoreSource): Promise<IgnoreRuleSet> {
	try {
		const text = await readFile(`${cwd}/${fileName}`, "utf8");
		return parseIgnorePatterns(source, text.split(/\r?\n/));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { rules: [], unsupportedNegations: 0 };
		throw error;
	}
}

export function mergeIgnoreRuleSets(...sets: IgnoreRuleSet[]): IgnoreRuleSet {
	return {
		rules: sets.flatMap((set) => set.rules),
		unsupportedNegations: sets.reduce((sum, set) => sum + set.unsupportedNegations, 0),
	};
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\0")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\0/g, ".*");
	return new RegExp(`^${escaped}$`);
}

function pathSegments(path: string): string[] {
	return toPosixPath(path).split("/").filter(Boolean);
}

function matchesRule(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
	if (rule.directoryOnly && !isDirectory && !relativePath.startsWith(`${rule.pattern}/`)) return false;
	const rel = toPosixPath(relativePath).replace(/^\//, "");
	const name = basename(rel);
	const pattern = rule.pattern;
	if (!pattern) return false;

	if (!/[?*\[]/.test(pattern)) {
		if (pattern.includes("/")) return rel === pattern || rel.startsWith(`${pattern}/`);
		return name === pattern || pathSegments(rel).includes(pattern);
	}

	const re = globToRegExp(pattern);
	if (pattern.includes("/")) return re.test(rel) || (isDirectory && re.test(`${rel}/`));
	return re.test(name) || pathSegments(rel).some((segment) => re.test(segment));
}

export function isIgnoredPath(relativePath: string, isDirectory: boolean, rules: readonly IgnoreRule[]): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (matchesRule(rule, relativePath, isDirectory)) ignored = !rule.negated;
	}
	return ignored;
}

export function toRipgrepExcludeGlob(rule: IgnoreRule): string | undefined {
	if (rule.negated) return undefined;
	if (!rule.pattern) return undefined;
	return rule.pattern;
}
