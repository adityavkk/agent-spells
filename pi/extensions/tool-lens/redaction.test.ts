import { describe, expect, it } from "bun:test";
import { DEFAULT_TOOL_LENS_CONFIG } from "./config";
import { buildRedactedPayload, redactText, stringifyForSnapshot } from "./redaction";

const REDACTION = DEFAULT_TOOL_LENS_CONFIG.redaction;

describe("redactText", () => {
	it("redacts env-like secret assignments but keeps the key name", () => {
		const { text, redacted } = redactText("API_KEY=sk-supersecretvalue123 and PORT=3000", REDACTION);
		expect(redacted).toBe(true);
		expect(text).toContain("API_KEY=[redacted]");
		expect(text).toContain("PORT=3000");
		expect(text).not.toContain("supersecret");
	});

	it("redacts bearer tokens and authorization headers", () => {
		const { text, redacted } = redactText("Authorization: Bearer abc.def.ghi123456", REDACTION);
		expect(redacted).toBe(true);
		expect(text).not.toContain("abc.def.ghi");
	});

	it("redacts PEM private key blocks", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		const { text, redacted } = redactText(pem, REDACTION);
		expect(redacted).toBe(true);
		expect(text).toBe("[redacted]");
	});

	it("redacts provider key prefixes", () => {
		const { redacted } = redactText("token ghp_0123456789abcdefghijABCDEFGHIJ", REDACTION);
		expect(redacted).toBe(true);
	});

	it("leaves benign text untouched", () => {
		const { text, redacted } = redactText("read README.md and summarize", REDACTION);
		expect(redacted).toBe(false);
		expect(text).toBe("read README.md and summarize");
	});

	it("honors disabled redaction", () => {
		const disabled = { ...REDACTION, enabled: false };
		const { text, redacted } = redactText("API_KEY=sk-secret", disabled);
		expect(redacted).toBe(false);
		expect(text).toBe("API_KEY=sk-secret");
	});

	it("applies extra user patterns", () => {
		const withExtra = { ...REDACTION, extraPatterns: ["INTERNAL-\\d+"] };
		const { text, redacted } = redactText("ref INTERNAL-4242 here", withExtra);
		expect(redacted).toBe(true);
		expect(text).toContain("[redacted]");
	});
});

describe("stringifyForSnapshot", () => {
	it("passes strings through and pretty-prints objects", () => {
		expect(stringifyForSnapshot("hi")).toBe("hi");
		expect(stringifyForSnapshot({ a: 1 })).toBe('{\n  "a": 1\n}');
		expect(stringifyForSnapshot(undefined)).toBe("");
	});
});

describe("buildRedactedPayload", () => {
	it("truncates past the limit with elision metadata", () => {
		const long = "lorem ipsum ".repeat(60); // 720 chars, no secret-like runs
		const payload = buildRedactedPayload(long, 100, REDACTION);
		expect(payload.truncated).toBe(true);
		expect(payload.text.length).toBeLessThan(long.length);
		expect(payload.text).toContain("chars elided");
		expect(payload.originalChars).toBe(long.length);
	});

	it("does not truncate short content and reports redaction", () => {
		const payload = buildRedactedPayload({ command: "echo SECRET_TOKEN=abc123def456" }, 4000, REDACTION);
		expect(payload.truncated).toBe(false);
		expect(payload.redacted).toBe(true);
		expect(payload.text).toContain("[redacted]");
	});
});
