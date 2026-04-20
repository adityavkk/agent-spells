import type { ModelProfilesConfig } from "../model-profiles/types";

export const DEFAULT_RENDER_MODEL_ROLE = "small";
export const DEFAULT_RENDER_E2E_PROFILE = "render-e2e";
export const DEFAULT_RENDER_E2E_ROLE = DEFAULT_RENDER_MODEL_ROLE;

export function buildRenderTestProfilesConfig(includeLocalRole: boolean): ModelProfilesConfig {
	return {
		activeProfile: DEFAULT_RENDER_E2E_PROFILE,
		profiles: {
			[DEFAULT_RENDER_E2E_PROFILE]: {
				defaultRole: DEFAULT_RENDER_E2E_ROLE,
				roles: {
					[DEFAULT_RENDER_E2E_ROLE]: {
						provider: "openai-codex",
						model: "gpt-5.4-mini",
						thinkingLevel: "minimal",
						fallback: includeLocalRole ? ["workhorse", "smart", "local"] : ["workhorse", "smart"],
					},
					workhorse: {
						provider: "openai-codex",
						model: "gpt-5.4",
						thinkingLevel: "low",
						fallback: ["smart"],
					},
					smart: {
						provider: "openai",
						model: "gpt-5.4",
						thinkingLevel: "low",
					},
					...(includeLocalRole
						? {
							local: {
								provider: "ollama",
								model: "gemma4:e4b",
								thinkingLevel: "low",
							},
						}
						: {}),
				},
			},
		},
	};
}
