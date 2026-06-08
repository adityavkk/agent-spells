import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

export type IgnoreSource = "explicit" | "gemini" | "git";

export interface IgnoreRule {
	pattern: string;
	source: IgnoreSource;
	negated: boolean;
	directoryOnly: boolean;
	anchored: boolean;
	basePath: string;
}

export interface IgnoreRuleSet {
	rules: IgnoreRule[];
	negatedRules: number;
	unsupportedNegations: number;
}

const EMPTY_RULE_SET: IgnoreRuleSet = { rules: [], negatedRules: 0, unsupportedNegations: 0 };

export function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeBasePath(basePath: string | undefined): string {
	return toPosixPath(basePath ?? "").replace(/^\/+|\/+$/g, "");
}

function unescapeLeadingCommentOrNegation(value: string): string {
	return value.startsWith("\\#") || value.startsWith("\\!") ? value.slice(1) : value;
}

export function parseIgnorePatterns(source: IgnoreSource, patterns: readonly string[] | undefined, basePath = ""): IgnoreRuleSet {
	const rules: IgnoreRule[] = [];
	let negatedRules = 0;
	for (const raw of patterns ?? []) {
		const trimmedRight = raw.replace(/\s+$/g, "");
		if (!trimmedRight) continue;
		if (trimmedRight.startsWith("#")) continue;

		const negated = trimmedRight.startsWith("!");
		const body = negated ? unescapeLeadingCommentOrNegation(trimmedRight.slice(1)) : unescapeLeadingCommentOrNegation(trimmedRight);
		const normalized = toPosixPath(body.trim()).replace(/\/{2,}/g, "/");
		const pattern = normalized.replace(/^\/+/, "").replace(/\/+$/, "");
		if (!pattern) continue;
		if (negated) negatedRules += 1;
		rules.push({
			pattern,
			source,
			negated,
			directoryOnly: normalized.endsWith("/"),
			anchored: normalized.startsWith("/"),
			basePath: normalizeBasePath(basePath),
		});
	}
	return { rules, negatedRules, unsupportedNegations: 0 };
}

export async function loadIgnoreFileAt(cwd: string, relativeDirectory: string, fileName: ".geminiignore" | ".gitignore", source: IgnoreSource): Promise<IgnoreRuleSet> {
	const basePath = normalizeBasePath(relativeDirectory);
	try {
		const text = await readFile(resolve(cwd, basePath, fileName), "utf8");
		return parseIgnorePatterns(source, text.split(/\r?\n/), basePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return EMPTY_RULE_SET;
		throw error;
	}
}

export async function loadIgnoreFile(cwd: string, fileName: ".geminiignore" | ".gitignore", source: IgnoreSource): Promise<IgnoreRuleSet> {
	return loadIgnoreFileAt(cwd, "", fileName, source);
}

export async function loadIgnoreHierarchy(cwd: string, directory: string, fileName: ".geminiignore" | ".gitignore", source: IgnoreSource): Promise<IgnoreRuleSet> {
	const relativeDirectory = toPosixPath(relative(cwd, directory));
	if (relativeDirectory.startsWith("..")) return loadIgnoreFile(cwd, fileName, source);
	const parts = relativeDirectory === "" ? [] : relativeDirectory.split("/").filter(Boolean);
	const sets: IgnoreRuleSet[] = [];
	for (let index = 0; index <= parts.length; index += 1) {
		sets.push(await loadIgnoreFileAt(cwd, parts.slice(0, index).join("/"), fileName, source));
	}
	return mergeIgnoreRuleSets(...sets);
}

export function mergeIgnoreRuleSets(...sets: IgnoreRuleSet[]): IgnoreRuleSet {
	return {
		rules: sets.flatMap((set) => set.rules),
		negatedRules: sets.reduce((sum, set) => sum + set.negatedRules, 0),
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

function joinRulePath(rule: IgnoreRule, pattern: string): string {
	return [rule.basePath, pattern].filter(Boolean).join("/");
}

function descendantOf(path: string, directory: string): boolean {
	return path === directory || path.startsWith(`${directory}/`);
}

function candidatePatterns(rule: IgnoreRule): string[] {
	const pattern = rule.pattern;
	if (rule.anchored || pattern.includes("/")) return [joinRulePath(rule, pattern)];
	const base = rule.basePath;
	return base ? [joinRulePath(rule, pattern), joinRulePath(rule, `**/${pattern}`)] : [pattern, `**/${pattern}`];
}

function matchesLiteralRule(rule: IgnoreRule, relativePath: string): boolean {
	const pattern = rule.pattern;
	if (rule.anchored || pattern.includes("/")) return descendantOf(relativePath, joinRulePath(rule, pattern));
	if (rule.basePath && !descendantOf(relativePath, rule.basePath)) return false;
	const scoped = rule.basePath ? relativePath.slice(rule.basePath.length).replace(/^\//, "") : relativePath;
	return pathSegments(scoped).includes(pattern) || basename(scoped) === pattern;
}

function matchesGlobRule(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
	for (const pattern of candidatePatterns(rule)) {
		const re = globToRegExp(pattern);
		if (re.test(relativePath) || re.test(`${relativePath}/`)) return true;
		if (rule.directoryOnly && (isDirectory ? re.test(relativePath) : relativePath.split("/").some((_, index, segments) => re.test(segments.slice(0, index + 1).join("/"))))) return true;
	}
	return false;
}

function matchesRule(rule: IgnoreRule, relativePath: string, isDirectory: boolean): boolean {
	const rel = toPosixPath(relativePath).replace(/^\/+/, "");
	if (!rel || !rule.pattern) return false;
	const hasGlob = /[?*\[]/.test(rule.pattern);
	const matched = hasGlob ? matchesGlobRule(rule, rel, isDirectory) : matchesLiteralRule(rule, rel);
	if (!matched) return false;
	if (!rule.directoryOnly) return true;
	if (isDirectory) return true;
	return candidatePatterns(rule).some((pattern) => descendantOf(rel, pattern.replace(/\/\*\*$/, "")));
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
	const pattern = rule.pattern.includes("/") || rule.anchored
		? joinRulePath(rule, rule.pattern)
		: joinRulePath(rule, `**/${rule.pattern}`);
	return rule.directoryOnly ? `${pattern}/**` : pattern;
}
