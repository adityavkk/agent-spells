import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { loadModelProfilesConfig } from "../model-profiles/config";
import { readModelProfilesState } from "../model-profiles/resolve";
import { completeWithModelRoleFallback } from "../model-profiles/runtime";
import type { ModelProfilesState, ResolvedRoleResult } from "../model-profiles/types";
import { loadRenderConfig } from "./config";
import { buildBamlRenderContext, parseBamlRenderResult } from "./extract";
import { normalizeRenderDoc } from "./normalize";
import { resolveRenderExtractionModel } from "./model-selection";
import type { RenderRuntime } from "./core";
import { createRenderSession, getRenderSessionSummary, readLatestRenderSession, RENDER_MESSAGE_CUSTOM_TYPE, type RenderSessionMessageDetails, withCurrentRenderRuntime } from "./session";
import { createRenderMessageComponent, RenderViewerComponent } from "./ui";

interface AssistantSource {
	entryId: string;
	text: string;
}

interface ExtractionResult {
	status: "success" | "cancelled" | "error";
	doc?: ReturnType<typeof parseBamlRenderResult>;
	message?: string;
}

async function resolveRenderModelRole(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
	cwd: string,
	state: ModelProfilesState,
): Promise<{
	resolved: ResolvedRoleResult | null;
	profileErrors: string[];
	renderErrors: string[];
}> {
	const loadedProfilesConfig = loadModelProfilesConfig(cwd);
	const loadedRenderConfig = loadRenderConfig(cwd);
	return {
		resolved: await resolveRenderExtractionModel({
			modelRegistry,
			config: loadedProfilesConfig.mergedConfig,
			renderConfig: loadedRenderConfig.mergedConfig,
			state,
			currentModel,
		}),
		profileErrors: loadedProfilesConfig.errors.map((error) => `${error.path}: ${error.message}`),
		renderErrors: loadedRenderConfig.errors.map((error) => `${error.path}: ${error.message}`),
	};
}

function getResponseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractLastAssistantSource(ctx: ExtensionContext): AssistantSource | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!("role" in message) || message.role !== "assistant") continue;
		if (message.stopReason !== "stop") {
			ctx.ui.notify(`Last assistant message incomplete (${message.stopReason})`, "error");
			return null;
		}
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!text) continue;
		return { entryId: entry.id, text };
	}
	ctx.ui.notify("No assistant messages found", "error");
	return null;
}

async function openRenderViewer(ctx: ExtensionContext, details: RenderSessionMessageDetails): Promise<RenderSessionMessageDetails> {
	const runtime = await ctx.ui.custom<RenderRuntime>((tui: TUI, theme, _kb, done) => new RenderViewerComponent(details.session, tui, theme, done));
	return {
		...details,
		session: withCurrentRenderRuntime(details.session, runtime),
	};
}

async function runExtraction(ctx: ExtensionContext, source: AssistantSource, resolved: ResolvedRoleResult): Promise<ExtractionResult> {
	const modelLabel = `${resolved.ref.provider}/${resolved.ref.model}`;
	return await ctx.ui.custom<ExtractionResult>((tui: TUI, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, `Rendering with ${modelLabel}...`);
		loader.onAbort = () => done({ status: "cancelled" });

		const doExtract = async () => {
			const extractionContext = await buildBamlRenderContext(source.text);
			const completion = await completeWithModelRoleFallback({
				resolved,
				modelRegistry: ctx.modelRegistry,
				context: extractionContext,
				buildOptions: (candidate, auth) => ({
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal: loader.signal,
					...(candidate.model.provider === "openai-codex" ? {} : { temperature: 0 }),
				}),
			});
			const response = completion.response;
			if (response.stopReason === "aborted") {
				return { status: "cancelled" } satisfies ExtractionResult;
			}
			if (response.stopReason === "error") {
				return {
					status: "error",
					message: response.errorMessage || "Render extraction failed",
				} satisfies ExtractionResult;
			}
			const text = getResponseText(response);
			try {
				return {
					status: "success",
					doc: text.trim().length > 0
						? parseBamlRenderResult(text, {
							fallbackMarkdown: source.text,
							defaultTitle: "Rendered response",
						})
						: normalizeRenderDoc({}, {
							fallbackMarkdown: source.text,
							defaultTitle: "Rendered response",
						}),
				} satisfies ExtractionResult;
			} catch (error) {
				return {
					status: "error",
					message: error instanceof Error ? error.message : String(error),
				} satisfies ExtractionResult;
			}
		};

		doExtract().then(done).catch((error) => done({
			status: "error",
			message: error instanceof Error ? error.message : String(error),
		}));

		return loader;
	});
}

export default function renderExtension(pi: ExtensionAPI) {
	pi.registerMessageRenderer<RenderSessionMessageDetails>(RENDER_MESSAGE_CUSTOM_TYPE, (message, { expanded }, theme) => {
		if (!message.details?.session) return undefined;
		return createRenderMessageComponent(message.details.session, theme, expanded);
	});

	pi.registerCommand("render", {
		description: "Render the last assistant message as a structured doc. Usage: /render or /render reopen",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("render requires interactive mode", "error");
				return;
			}

			const command = args.trim().toLowerCase();
			if (command && command !== "reopen") {
				ctx.ui.notify("Usage: /render or /render reopen", "error");
				return;
			}

			if (command === "reopen") {
				const session = readLatestRenderSession(ctx.sessionManager.getBranch());
				if (!session) {
					ctx.ui.notify("No render sessions found on this branch", "error");
					return;
				}
				await openRenderViewer(ctx, { session });
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const source = extractLastAssistantSource(ctx);
			if (!source) return;

			const modelProfilesState = readModelProfilesState(ctx.sessionManager.getBranch());
			const { resolved, profileErrors, renderErrors } = await resolveRenderModelRole(ctx.model, ctx.modelRegistry, ctx.cwd, modelProfilesState);
			for (const error of profileErrors) ctx.ui.notify(`model-profiles config error: ${error}`, "warning");
			for (const error of renderErrors) ctx.ui.notify(`render config error: ${error}`, "warning");
			if (!resolved) {
				ctx.ui.notify("No render extraction model available", "error");
				return;
			}

			const extraction = await runExtraction(ctx, source, resolved);
			if (extraction.status === "cancelled") {
				ctx.ui.notify("Cancelled", "info");
				return;
			}
			if (extraction.status === "error" || !extraction.doc) {
				ctx.ui.notify(extraction.message ?? "Render extraction failed", "error");
				return;
			}

			const initialDetails: RenderSessionMessageDetails = {
				session: createRenderSession({
					doc: extraction.doc,
					sourceEntryId: source.entryId,
					sourceSessionFile: ctx.sessionManager.getSessionFile(),
					reason: "extract-last-assistant",
					surface: "tui",
				}),
			};
			const details = await openRenderViewer(ctx, initialDetails);
			pi.sendMessage({
				customType: RENDER_MESSAGE_CUSTOM_TYPE,
				content: `Opened render view: ${getRenderSessionSummary(details.session)}`,
				display: true,
				details,
			});
			ctx.ui.notify("Render session saved", "info");
		},
	});
}
