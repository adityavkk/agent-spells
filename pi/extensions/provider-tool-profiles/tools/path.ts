/**
 * Path-policy enforcement for provider tool profiles.
 *
 * Provider harnesses disagree about which paths a tool may touch, so the
 * implementation plan (`docs/tool-behavior-matrix.md`) requires an explicit,
 * tested policy table instead of a single shared resolver. This module is that
 * table in code.
 *
 * Keep this module independent from Letta vendored schemas and Pi compatibility
 * imports. Letta defines provider-facing names/arguments. Pi compatibility
 * defines runtime primitives. This file defines only provider-tool path policy.
 */

import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { normalize as posixNormalize } from "node:path/posix";

/** Outcome of validating a raw provider path against a policy. */
export type PathValidation =
	| { ok: true; relativePath: string }
	| { ok: false; reason: string };

/** Outcome of fully resolving a raw provider path to an absolute location. */
export type PathResolution =
	| { ok: true; absolutePath: string; relativePath: string }
	| { ok: false; reason: string };

export interface ResolvedPath {
	absolutePath: string;
	relativePath: string;
}

const NUL = "\0";

/**
 * Detect absolute paths from either POSIX or Windows conventions.
 *
 * `node:path` on POSIX does not recognize `C:\foo` as absolute, so policies
 * that reject or constrain absolute paths need explicit Windows detection in
 * addition to the POSIX leading-slash case.
 */
function looksAbsolute(rawPath: string): boolean {
	if (rawPath.startsWith("/")) return true; // POSIX absolute
	if (/^[A-Za-z]:[/\\]/.test(rawPath)) return true; // Windows drive, e.g. C:\ or C:/
	if (rawPath.startsWith("\\")) return true; // Windows UNC or drive-relative root
	return false;
}

function hasParentSegment(rawPath: string): boolean {
	return rawPath.split(/[\\/]+/).some((part) => part === "..");
}

function displayRelativePath(cwd: string, absolutePath: string): string {
	const rel = relative(cwd, absolutePath);
	const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
	return rel && !escapes ? rel : absolutePath;
}

function stripLeadingAt(rawPath: string): string {
	return rawPath.trim().replace(/^@/, "");
}

function rejectEmptyOrNul(rawPath: string): string | undefined {
	if (!rawPath) return "empty path";
	if (rawPath.includes(NUL)) return "path contains NUL byte";
	return undefined;
}

/** True when `child` is `parent` itself or nested somewhere beneath it. */
function isWithin(parent: string, child: string): boolean {
	if (child === parent) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

/**
 * Canonicalize the nearest existing ancestor of `absolutePath` via `realpath`,
 * then re-attach the non-existent tail. This resolves symlinks in the portion
 * of the path that exists (the only portion that can be a symlink) so callers
 * can detect targets that escape `cwd` through a symlinked directory.
 */
async function canonicalize(absolutePath: string): Promise<string> {
	const tail: string[] = [];
	let current = absolutePath;
	// Walk up until we find a path component that exists on disk.
	while (true) {
		try {
			const real = await realpath(current);
			return tail.length ? resolve(real, ...tail) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(current, ...tail); // reached filesystem root
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Confirm that `absolutePath` stays within `cwd` after symlink canonicalization.
 *
 * Both sides are canonicalized so platform-specific symlinks (for example macOS
 * `/tmp` -> `/private/tmp`) do not produce false rejections.
 */
export async function isWithinCwd(cwd: string, absolutePath: string): Promise<boolean> {
	const [canonicalCwd, canonicalTarget] = await Promise.all([canonicalize(cwd), canonicalize(absolutePath)]);
	return isWithin(canonicalCwd, canonicalTarget);
}

export function requireResolvedPath(resolution: PathResolution, label = "path"): ResolvedPath {
	if (!resolution.ok) throw new Error(`${label}: ${resolution.reason}`);
	return resolution;
}

/**
 * Resolve a Claude-style path while preserving current Claude/Letta behavior.
 *
 * Policy: absolute paths are allowed, relatives resolve against `cwd`, one
 * leading `@` is stripped, `~`/`~/` expands to the current user's home, and
 * shell-style `$VAR` expansion is intentionally not performed.
 */
export function resolveClaudePath(cwd: string, rawPath: string): PathResolution {
	let prepared = stripLeadingAt(rawPath);
	const rejection = rejectEmptyOrNul(prepared);
	if (rejection) return { ok: false, reason: rejection };

	if (prepared === "~") prepared = homedir();
	else if (prepared.startsWith("~/")) prepared = resolve(homedir(), prepared.slice(2));

	if (looksAbsolute(prepared) && !isAbsolute(prepared)) {
		return { ok: false, reason: "Windows absolute paths are not supported on this platform" };
	}

	const absolutePath = isAbsolute(prepared) ? resolve(prepared) : resolve(cwd, prepared);
	return { ok: true, absolutePath, relativePath: displayRelativePath(cwd, absolutePath) };
}

async function resolveUnderCwd(cwd: string, rawPath: string): Promise<PathResolution> {
	const prepared = rawPath.trim();
	const rejection = rejectEmptyOrNul(prepared);
	if (rejection) return { ok: false, reason: rejection };
	if (hasParentSegment(prepared)) return { ok: false, reason: "parent-directory paths are not allowed" };

	let absolutePath: string;
	if (looksAbsolute(prepared)) {
		if (!isAbsolute(prepared)) return { ok: false, reason: "Windows absolute paths are not supported on this platform" };
		absolutePath = resolve(prepared);
	} else {
		absolutePath = resolve(cwd, prepared);
	}

	if (!(await isWithinCwd(cwd, absolutePath))) {
		return { ok: false, reason: "path escapes the working directory" };
	}
	return { ok: true, absolutePath, relativePath: displayRelativePath(cwd, absolutePath) };
}

/**
 * Resolve a Gemini file/search/list path.
 *
 * Policy: relatives resolve against `cwd`; absolute paths are allowed only when
 * they canonicalize under `cwd`; NUL bytes, parent-directory segments, Windows
 * absolute forms on POSIX, and symlink escapes are rejected. `~` and `$VAR` are
 * not expanded.
 */
export async function resolveGeminiPath(cwd: string, rawPath: string): Promise<PathResolution> {
	return resolveUnderCwd(cwd, rawPath);
}

/**
 * Resolve a provider shell working directory that must already exist under cwd.
 *
 * Used by Codex `shell_command.workdir` and Gemini `run_shell_command.dir_path`.
 * The missing value case is handled by callers as "use ctx.cwd"; a present but
 * empty string is rejected here.
 */
export async function resolveExistingDirectoryUnderCwd(cwd: string, rawPath: string): Promise<PathResolution> {
	const resolution = await resolveUnderCwd(cwd, rawPath);
	if (!resolution.ok) return resolution;
	try {
		const info = await stat(resolution.absolutePath);
		if (!info.isDirectory()) return { ok: false, reason: "path is not a directory" };
	} catch {
		return { ok: false, reason: "directory does not exist" };
	}
	return resolution;
}

/**
 * Resolve Codex `view_image.path`.
 *
 * Policy: read-only wrapper, so absolute local paths are allowed; relatives
 * resolve against `cwd`; one leading `@` is stripped for parity with image
 * attachment UX. No cwd containment, home expansion, or environment expansion
 * is performed.
 */
export function resolveCodexImagePath(cwd: string, rawPath: string): PathResolution {
	const prepared = stripLeadingAt(rawPath);
	const rejection = rejectEmptyOrNul(prepared);
	if (rejection) return { ok: false, reason: rejection };
	if (looksAbsolute(prepared) && !isAbsolute(prepared)) {
		return { ok: false, reason: "Windows absolute paths are not supported on this platform" };
	}
	const absolutePath = isAbsolute(prepared) ? resolve(prepared) : resolve(cwd, prepared);
	return { ok: true, absolutePath, relativePath: displayRelativePath(cwd, absolutePath) };
}

/**
 * Validate a Codex `apply_patch` path without touching the filesystem.
 *
 * Returns the POSIX-normalized relative path on success. Rejects empty paths,
 * NUL bytes, backslash separators, absolute paths, `~` home expansion, and any
 * path that normalizes to a parent-directory escape.
 */
export function validatePatchPath(rawPath: string): PathValidation {
	const trimmed = rawPath.trim();
	if (!trimmed) return { ok: false, reason: "empty path" };
	if (trimmed.includes(NUL)) return { ok: false, reason: "path contains NUL byte" };
	// Codex patches use POSIX forward-slash separators. Rejecting backslashes
	// keeps Windows absolute/UNC/traversal forms out without ambiguous parsing.
	if (trimmed.includes("\\")) return { ok: false, reason: "path must use '/' separators" };
	if (trimmed === "~" || trimmed.startsWith("~/")) return { ok: false, reason: "home-relative paths are not allowed" };
	if (looksAbsolute(trimmed)) return { ok: false, reason: "absolute paths are not allowed" };

	const normalized = posixNormalize(trimmed);
	if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
		return { ok: false, reason: "path escapes the working directory" };
	}
	return { ok: true, relativePath: normalized };
}

/**
 * Resolve a Codex `apply_patch` path to an absolute location under `cwd`.
 *
 * Combines {@link validatePatchPath} (static policy) with {@link isWithinCwd}
 * (symlink-aware containment). Returns the absolute path plus the normalized
 * relative path used for model-facing result text.
 */
export async function resolvePatchPath(cwd: string, rawPath: string): Promise<PathResolution> {
	const validation = validatePatchPath(rawPath);
	if (!validation.ok) return validation;
	const absolutePath = resolve(cwd, validation.relativePath);
	if (!(await isWithinCwd(cwd, absolutePath))) {
		return { ok: false, reason: "path escapes the working directory" };
	}
	return { ok: true, absolutePath, relativePath: validation.relativePath };
}
