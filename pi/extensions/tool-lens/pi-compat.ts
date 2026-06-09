/**
 * tool-lens compatibility boundary for Pi public APIs.
 *
 * Keep all direct Pi package imports in this file. Other modules import from
 * `./pi-compat` instead of reaching into Pi packages directly, so there is one
 * small, auditable place to update when Pi's package names or public exports
 * move. This boundary imports only public package entrypoints; never `dist/**`
 * or other private paths.
 */

export { Text } from "@mariozechner/pi-tui";
export type { Component, KeyId, TUI } from "@mariozechner/pi-tui";

export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderer,
	Theme,
} from "@mariozechner/pi-coding-agent";

export type { AgentMessage } from "@mariozechner/pi-agent-core";

export type {
	Api,
	AssistantMessageEvent,
	Context,
	Message,
	Model,
} from "@mariozechner/pi-ai";
