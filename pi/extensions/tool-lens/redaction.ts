/**
 * Redaction and truncation for tool inputs/outputs before they reach the
 * analyzer model, the rendered HUD/cards, or persisted entries.
 *
 * Redaction is conservative and fail-safe: if it throws, callers treat the
 * payload as un-analyzable (config `redaction.onFailure: "skip"`). We never try
 * to be clever about reconstructing secrets; we replace any matched span with a
 * fixed placeholder and record that redaction occurred.
 */
import type { RedactedPayload, ToolLensConfig } from "./types";

const PLACEHOLDER = "[redacted]";

/** Built-in secret-ish patterns. Intentionally broad; prefer over-redaction. */
const BUILTIN_PATTERNS: RegExp[] = [
	// PEM private key blocks.
	/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
	// Authorization headers (bearer/basic): redact the whole header value.
	/\b(authorization|x-api-key|api-key|proxy-authorization)\b\s*[:=]\s*[^\n]+/gi,
	// Bearer tokens.
	/\bBearer\s+[A-Za-z0-9._\-]+/g,
	// Common provider key prefixes (OpenAI, GitHub, Slack, Google, AWS, Anthropic).
	/\b(sk|pk|rk)-[A-Za-z0-9]{16,}/g,
	/\bgh[posu]_[A-Za-z0-9]{20,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_\-]{20,}/g,
	/\bAKIA[0-9A-Z]{12,}/g,
	/\bsk-ant-[A-Za-z0-9_\-]{16,}/g,
	// Long base64/hex blobs that look like tokens (>=32 chars).
	/\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];

/** KEY=value pairs where the key name implies a secret. */
const ENV_LIKE_PATTERN =
	/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;

function compileExtraPatterns(patterns: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, "g"));
		} catch {
			// Ignore malformed user patterns rather than failing redaction wholesale.
		}
	}
	return compiled;
}

/**
 * Redact secret-like spans from text. Returns the cleaned text and whether any
 * redaction happened. Throws only on catastrophic regex failure, which the
 * caller maps to "skip".
 */
export function redactText(text: string, config: ToolLensConfig["redaction"]): { text: string; redacted: boolean } {
	if (!config.enabled) return { text, redacted: false };
	let result = text;
	let redacted = false;

	const apply = (pattern: RegExp): void => {
		pattern.lastIndex = 0;
		if (pattern.test(result)) {
			pattern.lastIndex = 0;
			result = result.replace(pattern, PLACEHOLDER);
			redacted = true;
		}
	};

	for (const pattern of BUILTIN_PATTERNS) apply(pattern);
	if (config.redactEnvLikeValues) {
		ENV_LIKE_PATTERN.lastIndex = 0;
		if (ENV_LIKE_PATTERN.test(result)) {
			ENV_LIKE_PATTERN.lastIndex = 0;
			result = result.replace(ENV_LIKE_PATTERN, (_match, key: string) => `${key}=${PLACEHOLDER}`);
			redacted = true;
		}
	}
	for (const pattern of compileExtraPatterns(config.extraPatterns)) apply(pattern);

	return { text: result, redacted };
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
	const head = Math.ceil(maxChars * 0.7);
	const tail = Math.floor(maxChars * 0.2);
	const removed = text.length - head - tail;
	const marker = `\n…[${removed} chars elided]…\n`;
	return { text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ""), truncated: true };
}

/** Stable JSON stringify of arbitrary tool args/results for snapshotting. */
export function stringifyForSnapshot(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * Build a redacted, truncated payload from arbitrary input. Redaction runs
 * before truncation so secrets straddling the truncation boundary are still
 * removed. `originalChars` reflects the post-redaction length.
 */
export function buildRedactedPayload(
	value: unknown,
	maxChars: number,
	redaction: ToolLensConfig["redaction"],
): RedactedPayload {
	const raw = stringifyForSnapshot(value);
	const { text: redactedText, redacted } = redactText(raw, redaction);
	const originalChars = redactedText.length;
	const { text, truncated } = truncate(redactedText, maxChars);
	return { text, redacted, truncated, originalChars };
}
