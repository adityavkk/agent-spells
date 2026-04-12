import { describe, expect, it } from "bun:test";
import { complete, type Model } from "@mariozechner/pi-ai";
import { loadModelProfilesConfig, mergeModelProfilesConfig } from "../model-profiles/config";
import { resolveModelRole } from "../model-profiles/resolve";
import { completeWithModelRoleFallback } from "../model-profiles/runtime";
import { BlockType, EmbeddedContentType, PreferredView, QuestionType } from "./baml_client/types";
import { buildBamlRenderContext, parseBamlRenderResult } from "./extract";
import { buildRenderTestProfilesConfig, DEFAULT_RENDER_E2E_ROLE } from "./model-selection";

const piSdkModulePath = process.env.PI_SDK_MODULE
	?? "/Users/auk000v/.bun/install/global/node_modules/@mariozechner/pi-coding-agent";
const { AuthStorage, ModelRegistry } = await import(piSdkModulePath);

const ollamaBaseUrl = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/v1\/?$/, "");
const requestedProvider = process.env.PI_RENDER_E2E_PROVIDER;
const requestedModelId = process.env.PI_RENDER_E2E_MODEL;
const requestedProfile = process.env.PI_RENDER_E2E_PROFILE;
const requestedRole = process.env.PI_RENDER_E2E_ROLE;

async function isOllamaAvailable(): Promise<boolean> {
	const base = ollamaBaseUrl;
	try {
		const response = await fetch(`${base}/api/tags`);
		return response.ok;
	} catch {
		return false;
	}
}

async function resolvePiModel() {
	if (process.env.PI_RENDER_E2E === "0") return null;

	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const ollamaAvailable = await isOllamaAvailable();

	if (requestedProvider && requestedModelId) {
		const explicitModel = modelRegistry.find(requestedProvider, requestedModelId);
		if (!explicitModel) return null;
		if (explicitModel.provider === "ollama" && !ollamaAvailable) return null;
		const auth = await modelRegistry.getApiKeyAndHeaders(explicitModel);
		if (!auth.ok) return null;
		return { authStorage, modelRegistry, model: explicitModel, auth, resolved: null };
	}

	const loadedConfig = loadModelProfilesConfig(process.cwd());
	const mergedConfig = mergeModelProfilesConfig(
		buildRenderTestProfilesConfig(ollamaAvailable),
		loadedConfig.mergedConfig,
	);
	const resolved = await resolveModelRole({
		modelRegistry,
		config: mergedConfig,
		profile: requestedProfile ? { value: requestedProfile, source: "env" } : undefined,
		role: { value: requestedRole ?? DEFAULT_RENDER_E2E_ROLE, source: requestedRole ? "env" : "config" },
	});
	if (!resolved) return null;
	if (resolved.model.provider === "ollama" && !ollamaAvailable) return null;
	const auth = await modelRegistry.getApiKeyAndHeaders(resolved.model);
	if (!auth.ok) return null;
	return { authStorage, modelRegistry, model: resolved.model, auth, resolved };
}

const piModel = await resolvePiModel();
const suite = piModel ? describe : describe.skip;
const model: Model<any> = piModel?.model!;

function getText(response: Awaited<ReturnType<typeof complete>>): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function hasLabeledListLikeBlock(parsed: ReturnType<typeof parseBamlRenderResult>, labels: string[]): boolean {
	return parsed.blocks.some((block) => {
		if (block.type === BlockType.LIST) {
			const itemLabels = block.items.map((item) => item.title ?? item.navLabel ?? item.bodyMarkdown);
			return labels.every((label) => itemLabels.some((itemLabel) => itemLabel.includes(label)));
		}
		if (block.type === BlockType.COLLECTION) {
			const itemLabels = block.collectionItems.map((item) => item.title ?? item.navLabel ?? "");
			return labels.every((label) => itemLabels.some((itemLabel) => itemLabel.includes(label)));
		}
		return false;
	});
}

function collectQuestions(parsed: ReturnType<typeof parseBamlRenderResult>) {
	const questions = [];
	for (const block of parsed.blocks) {
		if (block.type === BlockType.QUESTIONNAIRE) {
			questions.push(...block.questions);
		}
		if (block.type === BlockType.COLLECTION) {
			for (const item of block.collectionItems) {
				if (item.content.type === EmbeddedContentType.QUESTIONNAIRE) {
					questions.push(...item.content.questions);
				}
			}
		}
	}
	return questions;
}

function collectIds(parsed: ReturnType<typeof parseBamlRenderResult>): string[] {
	const ids: string[] = [];
	for (const block of parsed.blocks) {
		if (block.id) ids.push(block.id);
		for (const item of block.items) {
			if (item.id) ids.push(item.id);
		}
		for (const question of block.questions) {
			if (question.id) ids.push(question.id);
			for (const option of question.options) {
				if (option.id) ids.push(option.id);
			}
		}
		for (const item of block.collectionItems) {
			if (item.id) ids.push(item.id);
			for (const nestedItem of item.content.items) {
				if (nestedItem.id) ids.push(nestedItem.id);
			}
			for (const nestedQuestion of item.content.questions) {
				if (nestedQuestion.id) ids.push(nestedQuestion.id);
				for (const option of nestedQuestion.options) {
					if (option.id) ids.push(option.id);
				}
			}
		}
	}
	return ids;
}

function assertNormalizedInvariants(parsed: ReturnType<typeof parseBamlRenderResult>): void {
	expect(parsed.blocks.length).toBeGreaterThan(0);
	const ids = collectIds(parsed);
	expect(new Set(ids).size).toBe(ids.length);

	for (const block of parsed.blocks) {
		if (block.type === BlockType.LIST) {
			if (block.preferredView === PreferredView.TABS) {
				expect(block.items.length).toBeGreaterThanOrEqual(2);
				expect(block.items.length).toBeLessThanOrEqual(7);
			}
			for (const item of block.items) {
				expect(item.bodyMarkdown.trim().length).toBeGreaterThan(0);
			}
		}
		if (block.type === BlockType.COLLECTION) {
			if (block.preferredView === PreferredView.TABS) {
				expect(block.collectionItems.length).toBeGreaterThanOrEqual(2);
				expect(block.collectionItems.length).toBeLessThanOrEqual(7);
			}
		}
	}
}

async function extractRenderedDoc(input: string, fallbackTitle: string) {
	if (!piModel) throw new Error("No pi model resolved for render integration test");
	const context = await buildBamlRenderContext(input);
	const response = piModel.resolved
		? (await completeWithModelRoleFallback({
			resolved: piModel.resolved,
			modelRegistry: piModel.modelRegistry,
			context,
			buildOptions: (candidate, auth) => ({
				apiKey: auth.apiKey,
				headers: auth.headers,
				...(candidate.model.provider === "openai-codex" ? {} : { temperature: 0 }),
			}),
		})).response
		: await complete(model, context, {
			apiKey: piModel.auth.apiKey,
			headers: piModel.auth.headers,
			...(model.provider === "openai-codex" ? {} : { temperature: 0 }),
		});
	return parseBamlRenderResult(getText(response), {
		fallbackMarkdown: fallbackTitle,
		defaultTitle: fallbackTitle,
	});
}

suite("render extension llm integration", () => {
	it("case 1: release brief mixed prose, checklist, nested questions, and views", { timeout: 240_000 }, async () => {
		const parsed = await extractRenderedDoc([
			"Structure this release brief for interactive rendering:",
			"Overview: We are launching Acorn Sync next week. Keep rollout boring and reversible.",
			"Checklist:",
			"- Freeze schema changes.",
			"- Verify dashboards.",
			"- Send launch announcement.",
			"Questions for the user:",
			"- Pick owners: API, UI, Docs. Multiple selections allowed and other is okay.",
			"- What risk worries you most? Answer in 1-2 sentences.",
			"Views to render separately:",
			"- API: token rotation, rate limits, migration notes.",
			"- UI: onboarding banner, empty states, release checklist.",
		].join("\n"), "Release brief");

		assertNormalizedInvariants(parsed);
		expect(parsed.blocks.length).toBeGreaterThanOrEqual(3);
		expect(!!parsed.introMarkdown || parsed.blocks.some((block) => block.type === BlockType.MARKDOWN)).toBeTrue();
		expect(parsed.blocks.some((block) => block.type === BlockType.LIST && block.items.length >= 3)).toBeTrue();

		const questions = collectQuestions(parsed);
		expect(questions.some((question) => question.type === QuestionType.MULTIPLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.TEXT)).toBeTrue();
		expect(hasLabeledListLikeBlock(parsed, ["API", "UI"])).toBeTrue();
	});

	it("case 2: environment matrix with separate views plus single-choice and ranking questions", { timeout: 240_000 }, async () => {
		const parsed = await extractRenderedDoc([
			"Prepare a deployment workspace document.",
			"Lead-in: This is the environment matrix for next week's release.",
			"Environment views to show separately:",
			"- Dev: synthetic traffic, verbose logging, sample data.",
			"- Staging: production-like data shape, smoke tests, rollback drill.",
			"- Prod: phased rollout, paging thresholds, customer comms.",
			"Decision questions:",
			"- Pick one rollout strategy: Canary, Blue/green, Big bang.",
			"- Rank these priorities: Reliability, Cost, Speed.",
		].join("\n"), "Deployment workspace");

		assertNormalizedInvariants(parsed);
		expect(hasLabeledListLikeBlock(parsed, ["Dev", "Staging", "Prod"])).toBeTrue();

		const questions = collectQuestions(parsed);
		expect(questions.some((question) => question.type === QuestionType.SINGLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.RANKING)).toBeTrue();
	});

	it("case 3: onboarding memo with prose, ordered steps, and clarifying questions", { timeout: 240_000 }, async () => {
		const parsed = await extractRenderedDoc([
			"Turn this onboarding memo into an interactive render doc.",
			"Intro: New teammates should ship something small in week one.",
			"Ordered steps:",
			"1. Clone the monorepo.",
			"2. Run the smoke suite.",
			"3. Pair on a tiny docs fix.",
			"Questions:",
			"- Which track fits you best: Backend, Frontend, Infra? Pick one.",
			"- Which tools do you already know? Git, Docker, Kubernetes, Terraform. Multiple selections allowed.",
			"- Any accessibility concerns we should know about? Answer in 1-2 sentences.",
		].join("\n"), "Onboarding memo");

		assertNormalizedInvariants(parsed);
		expect(!!parsed.introMarkdown || parsed.blocks.some((block) => block.type === BlockType.MARKDOWN)).toBeTrue();
		expect(parsed.blocks.some((block) => block.type === BlockType.LIST && block.items.length >= 3)).toBeTrue();

		const questions = collectQuestions(parsed);
		expect(questions.some((question) => question.type === QuestionType.SINGLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.MULTIPLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.TEXT)).toBeTrue();
	});

	it("case 4: migration plan with service views and mixed question types", { timeout: 240_000 }, async () => {
		const parsed = await extractRenderedDoc([
			"Structure this migration plan for rendering.",
			"Background: We are splitting the legacy service before quarter end.",
			"Workstreams to inspect separately:",
			"- Database: backfill, dual writes, consistency checks.",
			"- API: version negotiation, auth compatibility, traffic shadowing.",
			"- Operations: alerts, rollback, runbook updates.",
			"Questions:",
			"- Choose the primary cutover window: Tuesday, Wednesday, Thursday.",
			"- Rank the main priorities: Safety, Speed, Simplicity.",
			"- Which owners should approve? DBA, API, SRE, Security. Multiple selections allowed.",
		].join("\n"), "Migration plan");

		assertNormalizedInvariants(parsed);
		expect(hasLabeledListLikeBlock(parsed, ["Database", "API", "Operations"])).toBeTrue();

		const questions = collectQuestions(parsed);
		expect(questions.some((question) => question.type === QuestionType.SINGLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.RANKING)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.MULTIPLE_CHOICE)).toBeTrue();
	});

	it("case 5: incident review with timeline, channels, and follow-up prompts", { timeout: 240_000 }, async () => {
		const parsed = await extractRenderedDoc([
			"Convert this incident review into a render doc.",
			"Summary: Checkout latency spiked for 18 minutes yesterday.",
			"Timeline:",
			"- 09:02 alert fired.",
			"- 09:07 incident declared.",
			"- 09:20 mitigation deployed.",
			"Review channels to inspect separately:",
			"- Customer impact: refunds, support volume, failed orders.",
			"- Engineering follow-up: caching bug, alert thresholds, load test gap.",
			"Questions:",
			"- Pick one severity label: Sev1, Sev2, Sev3.",
			"- Which follow-ups matter most? Load testing, dashboards, rollback drills, oncall training. Multiple selections allowed.",
			"- What lesson should we repeat next time? Answer in 1-3 sentences.",
		].join("\n"), "Incident review");

		assertNormalizedInvariants(parsed);
		expect(parsed.blocks.some((block) => block.type === BlockType.LIST && block.items.length >= 3)).toBeTrue();
		expect(hasLabeledListLikeBlock(parsed, ["Customer", "Engineering"])).toBeTrue();

		const questions = collectQuestions(parsed);
		expect(questions.some((question) => question.type === QuestionType.SINGLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.MULTIPLE_CHOICE)).toBeTrue();
		expect(questions.some((question) => question.type === QuestionType.TEXT)).toBeTrue();
	});
});
