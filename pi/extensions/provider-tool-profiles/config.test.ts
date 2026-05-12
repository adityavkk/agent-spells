import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getGlobalProviderToolProfilesPath,
	loadProviderToolProfilesConfig,
	mergeProviderToolProfilesConfig,
	normalizeProviderToolProfilesConfig,
} from "./config";

describe("normalizeProviderToolProfilesConfig", () => {
	it("normalizes profile toggles, fallback tools, and matchers", () => {
		expect(normalizeProviderToolProfilesConfig({
			enabled: false,
			fallbackTools: [" read ", "read", "bash"],
			profiles: { claude: false, gemini: true, unknown: false },
			matchers: { claude: { providerIncludes: [" Anthropic ", ""] } },
		})).toEqual({
			enabled: false,
			preserveExtensionTools: undefined,
			fallbackTools: ["read", "bash"],
			profiles: { claude: false, gemini: true },
			matchers: { claude: { providerIncludes: ["anthropic"], idIncludes: undefined, apiIncludes: undefined } },
		});
	});
});

describe("mergeProviderToolProfilesConfig", () => {
	it("uses defaults and project overrides", () => {
		const merged = mergeProviderToolProfilesConfig({ profiles: { codex: false } }, { profiles: { gemini: false } });
		expect(merged.enabled).toBe(true);
		expect(merged.profiles).toEqual({ claude: true, codex: false, gemini: false });
		expect(merged.fallbackTools).toEqual(["read", "bash", "edit", "write"]);
	});
});

describe("loadProviderToolProfilesConfig", () => {
	it("loads global and project config files", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-tool-config-"));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(getGlobalProviderToolProfilesPath(agentDir), JSON.stringify({ profiles: { codex: false } }));
		writeFileSync(join(cwd, ".pi", "provider-tool-profiles.json"), JSON.stringify({ profiles: { gemini: false } }));
		const loaded = loadProviderToolProfilesConfig(cwd, agentDir);
		expect(loaded.errors).toEqual([]);
		expect(loaded.mergedConfig.profiles).toEqual({ claude: true, codex: false, gemini: false });
	});
});
