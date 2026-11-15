import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import modelProfilesExtension from "./index";
import type { LoadedModelProfilesConfig, SessionEntryLike } from "./types";

const STATE = "model-profiles-state";

function model(provider: string, id: string): Model<any> {
	return {
		provider, id, name: id, api: "anthropic-messages", baseUrl: "https://example.invalid",
		reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 32_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

// Persist only selection metadata. No user configuration, credentials, messages, or requests.
function fixture() {
	const raw = model("gateway-claude-personal", "claude-personal/claude-opus-5-5");
	const target = model("gateway-work", "work/claude-opus-5-5");
	const synthetic = model("profiles", "work:smart");
	const entries: SessionEntryLike[] = [];
	const models = new Map([raw, target].map((item) => [`${item.provider}/${item.id}`, item]));
	const config = {
		activeProfile: "work",
		profiles: { work: { defaultRole: "smart", roles: { smart: { provider: target.provider, model: target.id } } } },
	};
	const loaded: LoadedModelProfilesConfig = {
		globalPath: "/synthetic/model-profiles.json", projectPath: "/synthetic/.pi/model-profiles.json",
		globalConfig: config, projectConfig: { profiles: {} }, mergedConfig: config, errors: [],
	};
	let handlers = new Map<string, Function[]>();
	let commands = new Map<string, any>();
	let flags: Record<string, string> = {};
	const selected: Model<any>[] = [];
	let status: string | undefined;
	const ctx = {
		cwd: "/synthetic", model: raw as Model<any> | undefined, hasUI: true,
		modelRegistry: {
			find: (provider: string, id: string) => models.get(`${provider}/${id}`),
			getAvailable: () => [target],
			getApiKeyAndHeaders: async () => ({ ok: true as const }),
		},
		sessionManager: { getBranch: () => entries },
		ui: { notify() {}, setStatus(_key: string, value: string | undefined) { status = value; } },
	};
	async function emit(event: string, data: object) {
		for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
	}
	async function select(next: Model<any>, source: "set" | "cycle" | "restore" = "set") {
		const previousModel = ctx.model;
		ctx.model = next;
		// Pi's native entry contains no source, even for initial and automatic choices.
		entries.push({ type: "model_change", provider: next.provider, modelId: next.id } as SessionEntryLike);
		await emit("model_select", { model: next, previousModel, source });
	}
	function install(nextFlags: Record<string, string> = {}) {
		flags = nextFlags;
		handlers = new Map();
		commands = new Map();
		const pi = {
			getFlag: (name: string) => flags[name], registerFlag() {},
			on(event: string, handler: Function) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			registerProvider(provider: string, definition: any) {
				for (const item of definition.models) models.set(`${provider}/${item.id}`, { ...item, provider });
			},
			unregisterProvider() {},
			appendEntry(customType: string, data: unknown) {
				entries.push({ type: "custom", customType, data: structuredClone(data) });
			},
			async setModel(next: Model<any>) { selected.push(next); await select(next); return true; },
			setThinkingLevel() {},
			events: { on() {}, emit() {} },
		};
		modelProfilesExtension(pi as unknown as ExtensionAPI, { loadConfig: () => loaded });
	}
	async function start(reason = "startup", nextFlags: Record<string, string> = {}) {
		install(nextFlags);
		await emit("session_start", { reason });
	}
	return {
		raw, target, synthetic, entries, models, config, ctx, selected, start, select,
		command: async (args: string) => commands.get("profile").handler(args, ctx as unknown as ExtensionContext),
		status: () => status,
	};
}

describe("model-profiles manual selection persistence", () => {
	let originalArgv: string[];
	let originalProfile: string | undefined;
	let originalRole: string | undefined;
	beforeEach(() => {
		originalArgv = process.argv;
		originalProfile = process.env.PI_MODEL_PROFILE;
		originalRole = process.env.PI_MODEL_ROLE;
		process.argv = ["bun", "test"];
		delete process.env.PI_MODEL_PROFILE;
		delete process.env.PI_MODEL_ROLE;
	});
	afterEach(() => {
		process.argv = originalArgv;
		if (originalProfile === undefined) delete process.env.PI_MODEL_PROFILE;
		else process.env.PI_MODEL_PROFILE = originalProfile;
		if (originalRole === undefined) delete process.env.PI_MODEL_ROLE;
		else process.env.PI_MODEL_ROLE = originalRole;
	});

	for (const source of ["set", "cycle"] as const) {
		for (const reason of ["reload", "startup"]) {
			it(`preserves raw ${source} selection across ${reason}`, async () => {
				const f = fixture();
				await f.start();
				expect(f.ctx.model?.provider).toBe("profiles");
				await f.select(f.raw, source);
				const selections = f.selected.length;
				await f.start(reason);
				expect(f.ctx.model).toEqual(f.raw);
				expect(f.selected).toHaveLength(selections);
				expect(f.status()).toBeUndefined();
			});
		}
	}

	it("keeps configured profiles for a fresh session with an initial raw model entry", async () => {
		const f = fixture();
		f.entries.push({ type: "model_change", provider: f.raw.provider, modelId: f.raw.id } as SessionEntryLike);
		await f.start();
		expect(f.ctx.model?.provider).toBe("profiles");
	});

	it("keeps older persisted profile state without a selection mode", async () => {
		const f = fixture();
		f.entries.push({ type: "custom", customType: STATE, data: { activeProfile: "work", activeRole: "smart" } });
		await f.start();
		expect(f.ctx.model?.provider).toBe("profiles");
	});

	it("persists explicit raw CLI selection for a later resume without flags", async () => {
		const f = fixture();
		await f.start("startup", { provider: f.raw.provider, model: f.raw.id });
		expect(f.ctx.model).toEqual(f.raw);
		await f.start();
		expect(f.ctx.model).toEqual(f.raw);
		expect(f.selected).toHaveLength(0);
	});

	for (const flags of [{ profile: "work" }, { role: "smart" }] as Record<string, string>[]) {
		it(`does not reapply launch --${Object.keys(flags)[0]} after a raw choice on reload`, async () => {
			const f = fixture();
			await f.start("startup", flags);
			await f.select(f.raw);
			await f.start("reload", flags);
			expect(f.ctx.model).toEqual(f.raw);
			expect(f.status()).toBeUndefined();
		});

		it(`reactivates a profile with --${Object.keys(flags)[0]} after a raw choice`, async () => {
			const f = fixture();
			await f.start();
			await f.select(f.raw);
			await f.start("startup", flags);
			expect(f.ctx.model?.provider).toBe("profiles");
			await f.start("reload");
			expect(f.ctx.model?.provider).toBe("profiles");
		});
	}

	it("does not reapply launch --model after a profile command on reload", async () => {
		const f = fixture();
		const flags = { provider: f.raw.provider, model: f.raw.id };
		await f.start("startup", flags);
		await f.command("work");
		await f.start("reload", flags);
		expect(f.ctx.model?.provider).toBe("profiles");
		expect(f.status()).toBe("work:smart");
	});

	for (const args of ["work", "smart"]) {
		it(`reactivates a profile with /profile ${args} after a raw choice`, async () => {
			const f = fixture();
			await f.start();
			await f.select(f.raw);
			await f.command(args);
			expect(f.ctx.model?.provider).toBe("profiles");
			await f.start("reload");
			expect(f.ctx.model?.provider).toBe("profiles");
		});
	}

	it("reactivates a profile when its synthetic model is selected", async () => {
		const f = fixture();
		await f.start();
		await f.select(f.raw);
		await f.select(f.synthetic);
		await f.start("reload");
		expect(f.ctx.model?.provider).toBe("profiles");
		expect(f.status()).toBe("work:smart");
	});

	it("does not persist the profile's own automatic raw fallback as a manual choice", async () => {
		const f = fixture();
		f.config.profiles.work.roles.smart.model = "not-available";
		f.ctx.model = undefined;
		await f.start();
		expect(f.ctx.model).toEqual(f.target);
		expect(f.selected).toHaveLength(1);
		f.config.profiles.work.roles.smart.model = f.target.id;
		await f.start("reload");
		expect(f.ctx.model?.provider).toBe("profiles");
	});

	it("does not interpret a restored raw model as a new manual choice", async () => {
		const f = fixture();
		await f.start();
		await f.select(f.raw, "restore");
		await f.start("reload");
		expect(f.ctx.model?.provider).toBe("profiles");
	});
});
