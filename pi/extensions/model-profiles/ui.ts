import { truncateToWidth, visibleWidth, type Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { ReadonlyFooterDataProvider } from "@mariozechner/pi-coding-agent";
import type { ContextUsage, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Model } from "@mariozechner/pi-ai";

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export interface ModelProfilesFooterState {
	ctx?: ExtensionContext;
	model?: Model<any>;
	thinkingLevel?: string;
	statusText?: string;
}

export function createModelProfilesFooter(
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	getState: () => ModelProfilesFooterState,
): Component {
	return {
		render(width: number): string[] {
			const { ctx, model, thinkingLevel, statusText } = getState();
			if (!ctx) return [];

			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			let totalCost = 0;

			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message" && entry.message.role === "assistant") {
					totalInput += entry.message.usage.input;
					totalOutput += entry.message.usage.output;
					totalCacheRead += entry.message.usage.cacheRead;
					totalCacheWrite += entry.message.usage.cacheWrite;
					totalCost += entry.message.usage.cost.total;
				}
			}

			const contextUsage: ContextUsage | undefined = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextPercentValue = contextUsage?.percent ?? 0;
			const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

			let pwd = ctx.sessionManager.getCwd();
			const home = process.env.HOME || process.env.USERPROFILE;
			if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;
			const branch = footerData.getGitBranch();
			if (branch) pwd = `${pwd} (${branch})`;
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) pwd = `${pwd} • ${sessionName}`;

			const statsParts = [];
			if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
			if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
			if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
			if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
			if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

			const contextPercentDisplay =
				contextPercent === "?"
					? `?/${formatTokens(contextWindow)}`
					: `${contextPercent}%/${formatTokens(contextWindow)}`;
			if (contextPercentValue > 90) statsParts.push(theme.fg("error", contextPercentDisplay));
			else if (contextPercentValue > 70) statsParts.push(theme.fg("warning", contextPercentDisplay));
			else statsParts.push(contextPercentDisplay);

			let statsLeft = statsParts.join(" ");
			const modelName = model?.id || "no-model";
			let rightSideWithoutProvider = modelName;
			if (model?.reasoning) {
				rightSideWithoutProvider =
					thinkingLevel && thinkingLevel !== "off" ? `${modelName} • ${thinkingLevel}` : `${modelName} • thinking off`;
			}
			let rightSide = rightSideWithoutProvider;
			if (footerData.getAvailableProviderCount() > 1 && model) {
				rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
				if (visibleWidth(statsLeft) + 2 + visibleWidth(rightSide) > width) rightSide = rightSideWithoutProvider;
			}

			if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width, "...");
			const padding = Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(rightSide));
			const statsLine = theme.fg("dim", statsLeft + " ".repeat(padding) + rightSide);
			const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
			const lines = [pwdLine, statsLine];

			const otherStatuses = Array.from(footerData.getExtensionStatuses().entries())
				.filter(([key]) => key !== "model-profiles")
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			if (otherStatuses.length > 0) {
				lines.push(truncateToWidth(theme.fg("dim", otherStatuses.join(" ")), width, theme.fg("dim", "...")));
			}

			if (statusText) {
				const clean = sanitizeStatusText(statusText);
				const truncated = truncateToWidth(clean, width, "...");
				const statusPadding = Math.max(0, width - visibleWidth(truncated));
				lines.push(theme.fg("dim", " ".repeat(statusPadding) + truncated));
			}

			return lines;
		},
		invalidate() {},
	};
}
