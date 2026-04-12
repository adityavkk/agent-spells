/**
 * Q&A extraction hook - extracts structured questions from assistant responses
 * and presents a richer answer UI with free-form, single-choice, and
 * multiple-choice questions.
 */

import { complete, type Model, type Api } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ModelRegistry, Theme } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { buildBamlExtractionContext, parseBamlExtractionResult } from "./extraction";
import { debugAnswer } from "./debug";
import { type AnswerSubmission, type ExtractionResult, type ExtractionUiResult } from "./core";
import { AnswerComponent } from "./ui";

const OLLAMA_PROVIDER = "ollama";
const GEMMA_MODEL_ID = "gemma4:e4b";

async function selectExtractionModel(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
): Promise<Model<Api>> {
	const gemmaModel = modelRegistry.find(OLLAMA_PROVIDER, GEMMA_MODEL_ID);
	if (gemmaModel) {
		const auth = await modelRegistry.getApiKeyAndHeaders(gemmaModel);
		if (auth.ok) {
			debugAnswer("select-model", {
				selected: `${gemmaModel.provider}/${gemmaModel.id}`,
				reason: "preferred-model-available",
			});
			return gemmaModel;
		}
		debugAnswer("select-model", {
			candidate: `${gemmaModel.provider}/${gemmaModel.id}`,
			reason: "preferred-model-auth-unavailable",
			error: auth.error,
		});
	}

	debugAnswer("select-model", {
		selected: `${currentModel.provider}/${currentModel.id}`,
		reason: "fallback-current-model",
	});
	return currentModel;
}

function extractLastAssistantText(ctx: ExtensionContext): string | null {
	const branch = ctx.sessionManager.getBranch();
	debugAnswer("scan-branch", { entries: branch.length });

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (!("role" in msg) || msg.role !== "assistant") continue;
		if (msg.stopReason !== "stop") {
			debugAnswer("assistant-message-incomplete", { stopReason: msg.stopReason });
			ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
			return null;
		}

		const textParts = msg.content
			.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
			.map((c: { type: "text"; text: string }) => c.text);
		if (textParts.length === 0) continue;

		const text = textParts.join("\n");
		debugAnswer("assistant-message-found", {
			chars: text.length,
			parts: textParts.length,
			preview: text,
		});
		return text;
	}

	debugAnswer("assistant-message-missing");
	ctx.ui.notify("No assistant messages found", "error");
	return null;
}

function summarizeQuestions(result: ExtractionResult): Array<Record<string, unknown>> {
	return result.questions.map((question, index) => ({
		index,
		type: question.type,
		question: question.question,
		options: question.options.map((option) => option.label),
		allowOther: question.allowOther,
	}));
}

export default function (pi: ExtensionAPI) {
	const answerHandler = async (ctx: ExtensionContext) => {
		debugAnswer("handler-start", { hasUI: ctx.hasUI, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null });

		if (!ctx.hasUI) {
			ctx.ui.notify("answer requires interactive mode", "error");
			return;
		}

		if (!ctx.model) {
			ctx.ui.notify("No model selected", "error");
			return;
		}

		const lastAssistantText = extractLastAssistantText(ctx);
		if (!lastAssistantText) {
			return;
		}

		const extractionModel = await selectExtractionModel(ctx.model, ctx.modelRegistry);
		const extractionModelLabel = `${extractionModel.provider}/${extractionModel.id}`;
		debugAnswer("extraction-start", {
			model: extractionModelLabel,
			assistantChars: lastAssistantText.length,
		});

		const extraction = await ctx.ui.custom<ExtractionUiResult>((tui: TUI, theme: Theme, _kb: unknown, done: (result: ExtractionUiResult) => void) => {
			const loader = new BorderedLoader(tui, theme, `Extracting questions using ${extractionModelLabel}...`);
			loader.onAbort = () => {
				debugAnswer("extraction-abort-requested");
				done({ status: "cancelled" });
			};

			const doExtract = async () => {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(extractionModel);
				if (!auth.ok) {
					throw new Error(auth.error);
				}
				const extractionContext = await buildBamlExtractionContext(lastAssistantText);
				debugAnswer("extraction-context-built", {
					systemChars: extractionContext.systemPrompt.length,
					messages: extractionContext.messages.length,
				});

				const response = await complete(
					extractionModel,
					extractionContext,
					{ apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal, temperature: 0 },
				);

				if (response.stopReason === "aborted") {
					debugAnswer("extraction-aborted-by-model");
					return { status: "cancelled" } satisfies ExtractionUiResult;
				}

				const responseText = response.content
					.filter((c: { type: string; text?: string }): c is { type: "text"; text: string } => c.type === "text")
					.map((c: { type: "text"; text: string }) => c.text)
					.join("\n");
				debugAnswer("extraction-response", {
					stopReason: response.stopReason,
					chars: responseText.length,
					preview: responseText,
				});

				let parsed: ExtractionResult;
				try {
					parsed = parseBamlExtractionResult(responseText);
				} catch (error) {
					debugAnswer("extraction-parse-failed", {
						model: extractionModelLabel,
						responsePreview: responseText,
						error,
					});
					return {
						status: "error",
						message: `Model ${extractionModelLabel} returned invalid structured data for question extraction.`,
					} satisfies ExtractionUiResult;
				}

				debugAnswer("extraction-parse-success", {
					questions: parsed.questions.length,
					details: summarizeQuestions(parsed),
				});
				return { status: "success", result: parsed } satisfies ExtractionUiResult;
			};

			doExtract()
				.then(done)
				.catch((error: unknown) => {
					debugAnswer("extraction-error", { error });
					done({
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				});

			return loader;
		});

		debugAnswer("extraction-finished", { status: extraction.status });
		if (extraction.status === "cancelled") {
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		if (extraction.status === "error") {
			ctx.ui.notify(extraction.message ?? "Question extraction failed", "error");
			return;
		}

		const extractionResult = extraction.result!;
		if (extractionResult.questions.length === 0) {
			debugAnswer("extraction-empty");
			ctx.ui.notify("No questions found in the last message", "info");
			return;
		}

		const answersResult = await ctx.ui.custom<AnswerSubmission | null>((tui: TUI, theme: Theme, _kb: unknown, done: (result: AnswerSubmission | null) => void) => {
			return new AnswerComponent(extractionResult.questions, tui, theme, done);
		});

		if (answersResult === null) {
			debugAnswer("answers-cancelled");
			ctx.ui.notify("Cancelled", "info");
			return;
		}

		debugAnswer("answers-submitted", {
			chars: answersResult.transcript.length,
			preview: answersResult.transcript,
			structuredAnswers: answersResult.structuredAnswers,
		});
		pi.sendMessage(
			{
				customType: "answers",
				content: "I answered your questions in the following way:\n\n" + answersResult.transcript,
				display: true,
				details: {
					questions: extractionResult.questions,
					answers: answersResult.structuredAnswers,
				},
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract structured questions from last assistant message into interactive Q&A",
		handler: (_args: string, ctx: ExtensionContext) => answerHandler(ctx),
	});

	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answerHandler,
	});
}
