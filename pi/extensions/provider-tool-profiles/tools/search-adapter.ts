import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { requireResolvedPath, resolveClaudePath, resolveExistingDirectoryUnderCwd } from "./path";
import { runProcess } from "./shared";
import { textResult, truncateTextHead, type TextResultDetails, type ToolTextResult } from "./results";
import { isIgnoredPath, loadIgnoreTree, mergeIgnoreRuleSets, parseIgnorePatterns, toPosixPath, toRipgrepExcludeGlob, type IgnoreRuleSet } from "./ignore-policy";

export type SearchProvider = "claude" | "gemini";
export type GrepOutputMode = "content" | "files_with_matches" | "count";

const RIPGREP_TIMEOUT_MS = 60_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_LINES = 2_000;
const MAX_SEARCH_BYTES = 50 * 1024;
const RG_MATCH_SEPARATOR = "\x1f";
const RG_CONTEXT_SEPARATOR = "\x1e";

export interface ProviderGlobInput {
	cwd: string;
	profile: SearchProvider;
	toolName: string;
	pattern: string;
	path?: unknown;
	caseSensitive?: boolean;
	respectGitIgnore?: boolean;
	respectGeminiIgnore?: boolean;
	exclude?: readonly string[];
	signal?: AbortSignal;
}

export interface ProviderGrepInput {
	cwd: string;
	profile: SearchProvider;
	toolName: string;
	pattern: string;
	path?: unknown;
	glob?: string;
	outputMode?: GrepOutputMode;
	context?: number;
	before?: number;
	after?: number;
	lineNumbers?: boolean;
	caseInsensitive?: boolean;
	type?: string;
	headLimit?: number;
	offset?: number;
	multiline?: boolean;
	respectGitIgnore?: boolean;
	respectGeminiIgnore?: boolean;
	signal?: AbortSignal;
}

export interface SearchResultDetails extends TextResultDetails {
	profile: SearchProvider;
	toolName: string;
	pattern: string;
	path: string;
	mode?: GrepOutputMode;
	matches?: number;
	results?: number;
	capped?: boolean;
	geminiIgnoreRules?: number;
	unsupportedGeminiIgnoreNegations?: number;
	geminiIgnoreDiscoveryTruncated?: boolean;
}

interface SearchTarget {
	absolutePath: string;
	cwdForRg: string;
	rgTarget: string;
	isDirectory: boolean;
}

interface SearchIgnoreRules {
	ruleSet: IgnoreRuleSet;
	geminiDiscoveryTruncated: boolean;
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${label}: expected string`);
	return value;
}

async function resolveSearchDirectory(input: Pick<ProviderGlobInput, "cwd" | "profile" | "path">): Promise<string> {
	const rawPath = optionalString(input.path, input.profile === "gemini" ? "dir_path" : "path");
	if (rawPath === undefined) return input.cwd;
	if (input.profile === "gemini") return requireResolvedPath(await resolveExistingDirectoryUnderCwd(input.cwd, rawPath), "dir_path").absolutePath;
	const resolved = requireResolvedPath(resolveClaudePath(input.cwd, rawPath), "path");
	const info = await stat(resolved.absolutePath);
	if (!info.isDirectory()) throw new Error("path: path is not a directory");
	return resolved.absolutePath;
}

async function resolveSearchTarget(input: Pick<ProviderGrepInput, "cwd" | "profile" | "path">): Promise<SearchTarget> {
	const rawPath = optionalString(input.path, input.profile === "gemini" ? "dir_path" : "path");
	if (rawPath === undefined) return { absolutePath: input.cwd, cwdForRg: input.cwd, rgTarget: ".", isDirectory: true };
	if (input.profile === "gemini") {
		const absolutePath = requireResolvedPath(await resolveExistingDirectoryUnderCwd(input.cwd, rawPath), "dir_path").absolutePath;
		return { absolutePath, cwdForRg: absolutePath, rgTarget: ".", isDirectory: true };
	}
	const absolutePath = requireResolvedPath(resolveClaudePath(input.cwd, rawPath), "path").absolutePath;
	const info = await stat(absolutePath);
	if (info.isDirectory()) return { absolutePath, cwdForRg: absolutePath, rgTarget: ".", isDirectory: true };
	return { absolutePath, cwdForRg: dirname(absolutePath), rgTarget: absolutePath, isDirectory: false };
}

async function ignoreRules(input: { cwd: string; profile: SearchProvider; root: string; respectGeminiIgnore?: boolean; exclude?: readonly string[] }): Promise<SearchIgnoreRules> {
	const explicit = parseIgnorePatterns("explicit", input.exclude);
	if (input.profile !== "gemini" || input.respectGeminiIgnore === false) return { ruleSet: explicit, geminiDiscoveryTruncated: false };
	const gemini = await loadIgnoreTree(input.cwd, input.root, ".geminiignore", "gemini");
	return { ruleSet: mergeIgnoreRuleSets(explicit, gemini.rules), geminiDiscoveryTruncated: gemini.truncated };
}

function addRipgrepGitIgnoreArg(args: string[], respectGitIgnore: boolean | undefined): void {
	if (respectGitIgnore === false) args.push("--no-ignore-vcs");
}

function addRipgrepExcludeArgs(args: string[], ignores: IgnoreRuleSet, caseInsensitive = false): void {
	// Ripgrep resolves later glob overrides last, so exclusions must be appended
	// after provider include globs to avoid re-including ignored paths.
	const flag = caseInsensitive ? "--iglob" : "--glob";
	for (const rule of ignores.rules) {
		const glob = toRipgrepExcludeGlob(rule);
		if (glob) args.push(flag, `!${glob}`);
	}
}

function canPreFilterWithRipgrep(ignores: IgnoreRuleSet, rgRoot: string, cwd: string): boolean {
	// Positive ignore negations cannot be represented safely as ripgrep --glob
	// includes without narrowing unrelated results. For those cases, run rg wide
	// and apply provider ignore semantics after discovery.
	return ignores.negatedRules === 0 && rgRoot === cwd;
}

function relativeResultPath(root: string, absolutePath: string): string {
	const rel = relative(root, absolutePath);
	return toPosixPath(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath);
}

function absoluteRgPath(rgRoot: string, path: string): string {
	return isAbsolute(path) ? path : join(rgRoot, path);
}

function ignoredRgPath(cwd: string, rgRoot: string, path: string, ignores: IgnoreRuleSet): boolean {
	if (ignores.rules.length === 0) return false;
	const relativePath = relativeResultPath(cwd, absoluteRgPath(rgRoot, path));
	return isIgnoredPath(relativePath, false, ignores.rules);
}

function firstSeparatorIndex(line: string): number {
	const matchIndex = line.indexOf(RG_MATCH_SEPARATOR);
	const contextIndex = line.indexOf(RG_CONTEXT_SEPARATOR);
	if (matchIndex === -1) return contextIndex;
	if (contextIndex === -1) return matchIndex;
	return Math.min(matchIndex, contextIndex);
}

function grepLinePath(line: string, mode: GrepOutputMode): string | undefined {
	if (mode === "files_with_matches") return line;
	if (mode === "count") {
		const separator = line.lastIndexOf(":");
		return separator === -1 ? undefined : line.slice(0, separator);
	}
	const separator = firstSeparatorIndex(line);
	return separator === -1 ? undefined : line.slice(0, separator);
}

function restoreGrepSeparators(line: string): string {
	return line.replaceAll(RG_MATCH_SEPARATOR, ":").replaceAll(RG_CONTEXT_SEPARATOR, "-");
}

async function sortPathsByMtime(root: string, paths: readonly string[]): Promise<string[]> {
	const entries = await Promise.all(paths.map(async (path) => {
		const absolutePath = join(root, path);
		try {
			const info = await stat(absolutePath);
			return { path: toPosixPath(path), mtimeMs: info.mtimeMs };
		} catch {
			return undefined;
		}
	}));
	return entries
		.filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
		.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
		.map((entry) => entry.path);
}

function capLines(lines: string[], maxLines: number): { lines: string[]; capped: boolean } {
	if (lines.length <= maxLines) return { lines, capped: false };
	return { lines: lines.slice(0, maxLines), capped: true };
}

function appendCapNotice(text: string, capped: boolean, limit: number, noun: string): string {
	if (!capped) return text;
	const notice = `[Search results capped at ${limit} ${noun}. Narrow the pattern or use a more specific path to continue.]`;
	return text ? `${text}\n\n${notice}` : notice;
}

export async function runProviderGlob(input: ProviderGlobInput): Promise<ToolTextResult<SearchResultDetails>> {
	const root = await resolveSearchDirectory(input);
	const ignores = await ignoreRules({ cwd: input.cwd, profile: input.profile, root, respectGeminiIgnore: input.respectGeminiIgnore, exclude: input.exclude });
	const args = ["--files", "--color=never"];
	addRipgrepGitIgnoreArg(args, input.respectGitIgnore);
	args.push(input.caseSensitive === false ? "--iglob" : "--glob", input.pattern);
	if (canPreFilterWithRipgrep(ignores.ruleSet, root, input.cwd)) addRipgrepExcludeArgs(args, ignores.ruleSet, input.caseSensitive === false);

	const result = await runProcess("rg", args, { cwd: root, timeoutMs: RIPGREP_TIMEOUT_MS, signal: input.signal });
	if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr || `rg exited ${result.code}`);
	const discovered = (result.code === 1 ? [] : result.stdout.trim().split("\n").filter(Boolean))
		.filter((path) => !ignoredRgPath(input.cwd, root, path, ignores.ruleSet));
	const sorted = await sortPathsByMtime(root, discovered);
	const capped = capLines(sorted, MAX_GLOB_RESULTS);
	const rawOutput = capped.lines.join("\n");
	const truncated = truncateTextHead(appendCapNotice(rawOutput, capped.capped, MAX_GLOB_RESULTS, "paths"), {
		maxLines: MAX_GLOB_RESULTS + 3,
		maxBytes: MAX_SEARCH_BYTES,
		continuationHint: "Narrow the glob pattern or directory to continue.",
	});
	return textResult(truncated.text || "No files found", {
		profile: input.profile,
		toolName: input.toolName,
		path: root,
		pattern: input.pattern,
		results: capped.lines.length,
		capped: capped.capped,
		truncated: truncated.truncated,
		geminiIgnoreRules: ignores.ruleSet.rules.filter((rule) => rule.source === "gemini").length,
		unsupportedGeminiIgnoreNegations: ignores.ruleSet.unsupportedNegations,
		geminiIgnoreDiscoveryTruncated: ignores.geminiDiscoveryTruncated,
	});
}

export async function runProviderGrep(input: ProviderGrepInput): Promise<ToolTextResult<SearchResultDetails>> {
	const target = await resolveSearchTarget(input);
	const ignores = await ignoreRules({ cwd: input.cwd, profile: input.profile, root: target.absolutePath, respectGeminiIgnore: input.respectGeminiIgnore });
	const mode = input.outputMode ?? "files_with_matches";
	const args = ["--color=never", "--sort", "path"];
	addRipgrepGitIgnoreArg(args, input.respectGitIgnore);
	const postFilterIgnores = ignores.ruleSet.rules.length > 0;
	if (mode === "files_with_matches") args.push("--files-with-matches");
	else if (mode === "count") args.push("--count");
	else {
		if (input.lineNumbers !== false) args.push("--line-number");
		if (postFilterIgnores) args.push("--field-match-separator", RG_MATCH_SEPARATOR, "--field-context-separator", RG_CONTEXT_SEPARATOR);
	}
	if (mode === "content") {
		if (typeof input.context === "number") args.push("-C", String(Math.max(0, Math.floor(input.context))));
		if (typeof input.before === "number") args.push("-B", String(Math.max(0, Math.floor(input.before))));
		if (typeof input.after === "number") args.push("-A", String(Math.max(0, Math.floor(input.after))));
	}
	if (input.glob) args.push("--glob", input.glob);
	if (canPreFilterWithRipgrep(ignores.ruleSet, target.cwdForRg, input.cwd)) addRipgrepExcludeArgs(args, ignores.ruleSet);
	if (input.caseInsensitive) args.push("--ignore-case");
	if (input.type) args.push("--type", input.type);
	if (input.multiline) args.push("--multiline", "--multiline-dotall");
	args.push("--", input.pattern, target.rgTarget);

	const result = await runProcess("rg", args, { cwd: target.cwdForRg, timeoutMs: RIPGREP_TIMEOUT_MS, signal: input.signal });
	if (result.code === 1) {
		return textResult("No matches found", {
			profile: input.profile,
			toolName: input.toolName,
			path: target.absolutePath,
			pattern: input.pattern,
			mode,
			matches: 0,
			truncated: false,
		});
	}
	if (result.code !== 0) throw new Error(result.stderr || `rg exited ${result.code}`);

	let lines = result.stdout.trimEnd().split("\n").filter((line) => line.length > 0);
	if (postFilterIgnores) {
		lines = lines
			.filter((line) => {
				const path = grepLinePath(line, mode);
				return path === undefined || !ignoredRgPath(input.cwd, target.cwdForRg, path, ignores.ruleSet);
			})
			.map(restoreGrepSeparators);
	}
	if (!target.isDirectory) {
		lines = lines.map((line) => line.replace(target.absolutePath, relativeResultPath(input.cwd, target.absolutePath)));
	}
	if (typeof input.offset === "number" && input.offset > 0) lines = lines.slice(Math.floor(input.offset));
	if (typeof input.headLimit === "number" && input.headLimit > 0) lines = lines.slice(0, Math.floor(input.headLimit));
	const capped = capLines(lines, MAX_GREP_LINES);
	const rawOutput = appendCapNotice(capped.lines.join("\n"), capped.capped, MAX_GREP_LINES, "lines");
	const truncated = truncateTextHead(rawOutput, {
		maxLines: MAX_GREP_LINES + 3,
		maxBytes: MAX_SEARCH_BYTES,
		continuationHint: "Use head_limit, offset, a narrower glob, or a more specific path to continue.",
	});
	return textResult(truncated.text || "No matches found", {
		profile: input.profile,
		toolName: input.toolName,
		path: target.absolutePath,
		pattern: input.pattern,
		mode,
		matches: capped.lines.length,
		capped: capped.capped,
		truncated: truncated.truncated,
		geminiIgnoreRules: ignores.ruleSet.rules.filter((rule) => rule.source === "gemini").length,
		unsupportedGeminiIgnoreNegations: ignores.ruleSet.unsupportedNegations,
		geminiIgnoreDiscoveryTruncated: ignores.geminiDiscoveryTruncated,
	});
}
