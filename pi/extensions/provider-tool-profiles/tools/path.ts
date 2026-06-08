/**
 * Path-policy enforcement for provider tool profiles.
 *
 * Provider harnesses disagree about which paths a tool may touch, so the
 * implementation plan (`docs/tool-behavior-matrix.md`) requires an explicit,
 * tested policy table instead of a single shared resolver. This module is the
 * foundation for that table.
 *
 * Policies currently implemented:
 *
 * - `patch` (Codex `apply_patch`): relative-only, POSIX-normalized, and
 *   contained within `cwd`. Codex's apply-patch grammar states that file
 *   references are never absolute, so absolute POSIX/Windows paths, `~`
 *   expansion, `..` traversal, NUL bytes, and symlink escapes are all rejected.
 *
 * The module keeps a hard split between cheap static validation (no filesystem
 * access) and filesystem-backed containment checks (symlink canonicalization),
 * so both halves can be unit-tested in isolation.
 */

import { realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { normalize as posixNormalize } from "node:path/posix";

/** Outcome of validating a raw provider path against a policy. */
export type PathValidation =
	| { ok: true; relativePath: string }
	| { ok: false; reason: string };

/** Outcome of fully resolving a raw provider path to an absolute location. */
export type PathResolution =
	| { ok: true; absolutePath: string; relativePath: string }
	| { ok: false; reason: string };

const NUL = "\0";

/**
 * Detect absolute paths from either POSIX or Windows conventions.
 *
 * `node:path` on POSIX does not recognize `C:\foo` as absolute, so the Codex
 * relative-only contract needs explicit Windows detection in addition to the
 * POSIX leading-slash case.
 */
function looksAbsolute(rawPath: string): boolean {
	if (rawPath.startsWith("/")) return true; // POSIX absolute
	if (/^[A-Za-z]:[/\\]/.test(rawPath)) return true; // Windows drive, e.g. C:\ or C:/
	if (rawPath.startsWith("\\")) return true; // Windows UNC or drive-relative root
	return false;
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
