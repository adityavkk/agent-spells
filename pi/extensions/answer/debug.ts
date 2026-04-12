const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_STRING_LENGTH = 240;

function debugEnabled(): boolean {
	const raw = process.env.PI_ANSWER_DEBUG;
	if (!raw) return false;
	return TRUE_VALUES.has(raw.trim().toLowerCase());
}

function truncateString(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}…`;
}

function sanitize(value: unknown): unknown {
	if (typeof value === "string") {
		return truncateString(value);
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: truncateString(value.message),
			stack: typeof value.stack === "string" ? truncateString(value.stack) : undefined,
		};
	}
	if (Array.isArray(value)) {
		return value.map((entry) => sanitize(entry));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]),
		);
	}
	return value;
}

export function debugAnswer(event: string, details?: Record<string, unknown>): void {
	if (!debugEnabled()) return;
	const payload = details ? ` ${JSON.stringify(sanitize(details))}` : "";
	console.error(`[answer] ${event}${payload}`);
}
