/**
 * Provider-tool-profiles compatibility boundary for Pi public APIs.
 *
 * Keep all direct Pi package imports in this file. Adapter/tool modules should
 * import from `./pi-compat` (or `./tools/pi-compat` from the extension root)
 * instead of importing Pi packages directly. That gives this extension one
 * small, auditable place to update when Pi's package name or public exports
 * move, and lets `scripts/check-pi-compat.ts` mechanically enforce that no
 * provider-tool implementation reaches into Pi internals.
 *
 * This boundary intentionally imports only public package entrypoints. Never
 * import `dist/**`, `core/**`, or other private paths here.
 */

export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	formatSize,
	truncateHead,
	truncateLine,
	truncateTail,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

export type {
	BashOperations,
	BashToolDetails,
	ExtensionAPI,
	ExtensionContext,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
	ToolDefinition,
	TruncationResult,
} from "@mariozechner/pi-coding-agent";

export type { Model } from "@mariozechner/pi-ai";

export { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
