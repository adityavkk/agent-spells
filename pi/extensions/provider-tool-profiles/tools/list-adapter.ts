import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { requireResolvedPath, resolveClaudePath, resolveExistingDirectoryUnderCwd } from "./path";
import { isIgnoredPath, loadIgnoreHierarchy, mergeIgnoreRuleSets, parseIgnorePatterns, toPosixPath, type IgnoreRuleSet } from "./ignore-policy";
import { textResult, truncateTextHead, type TextResultDetails, type ToolTextResult } from "./results";

export type ListProvider = "claude" | "gemini";

const MAX_LIST_ENTRIES = 500;
const MAX_LIST_BYTES = 50 * 1024;

export interface FileFilteringOptions {
	respect_git_ignore?: boolean;
	respect_gemini_ignore?: boolean;
}

export interface ProviderListInput {
	cwd: string;
	profile: ListProvider;
	toolName: string;
	path: unknown;
	ignore?: readonly string[];
	fileFilteringOptions?: FileFilteringOptions;
}

export interface ListResultDetails extends TextResultDetails {
	profile: ListProvider;
	toolName: string;
	path: string;
	entries: number;
	shown: number;
	capped: boolean;
	ignored: number;
	gitIgnoreRules?: number;
	geminiIgnoreRules?: number;
	unsupportedIgnoreNegations?: number;
}

async function resolveListDirectory(input: ProviderListInput): Promise<string> {
	if (typeof input.path !== "string") throw new Error(`${input.profile === "gemini" ? "dir_path" : "path"}: expected string`);
	if (input.profile === "gemini") return requireResolvedPath(await resolveExistingDirectoryUnderCwd(input.cwd, input.path), "dir_path").absolutePath;
	const resolved = requireResolvedPath(resolveClaudePath(input.cwd, input.path), "path");
	const info = await stat(resolved.absolutePath);
	if (!info.isDirectory()) throw new Error("path: path is not a directory");
	return resolved.absolutePath;
}

async function ignoreRules(input: ProviderListInput, directory: string): Promise<IgnoreRuleSet> {
	const explicit = parseIgnorePatterns("explicit", input.ignore);
	if (input.profile !== "gemini") return explicit;
	const git = input.fileFilteringOptions?.respect_git_ignore === false ? { rules: [], negatedRules: 0, unsupportedNegations: 0 } : await loadIgnoreHierarchy(input.cwd, directory, ".gitignore", "git");
	const gemini = input.fileFilteringOptions?.respect_gemini_ignore === false ? { rules: [], negatedRules: 0, unsupportedNegations: 0 } : await loadIgnoreHierarchy(input.cwd, directory, ".geminiignore", "gemini");
	return mergeIgnoreRuleSets(explicit, git, gemini);
}

function displayPath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	return toPosixPath(rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolutePath);
}

function sortEntries(a: { name: string; isDirectory: boolean }, b: { name: string; isDirectory: boolean }): number {
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	return a.name.localeCompare(b.name);
}

function capRows(rows: string[]): { rows: string[]; capped: boolean } {
	if (rows.length <= MAX_LIST_ENTRIES) return { rows, capped: false };
	return { rows: rows.slice(0, MAX_LIST_ENTRIES), capped: true };
}

export async function listProviderDirectory(input: ProviderListInput): Promise<ToolTextResult<ListResultDetails>> {
	const directory = await resolveListDirectory(input);
	const rules = await ignoreRules(input, directory);
	const entries = await readdir(directory, { withFileTypes: true });
	const rows = entries.map((entry) => {
		const absolutePath = join(directory, entry.name);
		const relativePath = displayPath(input.cwd, absolutePath);
		return {
			name: entry.name,
			label: entry.isDirectory() ? `${entry.name}/` : entry.name,
			relativePath,
			isDirectory: entry.isDirectory(),
		};
	});
	const visible = rows
		.filter((entry) => !isIgnoredPath(entry.relativePath, entry.isDirectory, rules.rules) && !isIgnoredPath(entry.name, entry.isDirectory, rules.rules))
		.sort(sortEntries);
	const capped = capRows(visible.map((entry) => entry.label));
	const notice = capped.capped ? `\n\n[List output capped at ${MAX_LIST_ENTRIES} entries. Use a narrower directory or ignore patterns to continue.]` : "";
	const truncated = truncateTextHead(`${capped.rows.join("\n") || "(empty)"}${notice}`, {
		maxLines: MAX_LIST_ENTRIES + 3,
		maxBytes: MAX_LIST_BYTES,
		continuationHint: "Use a narrower directory or ignore patterns to continue.",
	});
	return textResult(truncated.text, {
		profile: input.profile,
		toolName: input.toolName,
		path: directory,
		entries: entries.length,
		shown: capped.rows.length,
		capped: capped.capped,
		ignored: entries.length - visible.length,
		truncated: truncated.truncated,
		gitIgnoreRules: rules.rules.filter((rule) => rule.source === "git").length,
		geminiIgnoreRules: rules.rules.filter((rule) => rule.source === "gemini").length,
		unsupportedIgnoreNegations: rules.unsupportedNegations,
	});
}
