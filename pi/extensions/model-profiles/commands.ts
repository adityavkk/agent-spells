import type { AutocompleteItem } from "@mariozechner/pi-tui";

export type ProfileCommandAction =
	| { kind: "interactive" }
	| { kind: "status" }
	| { kind: "reload" }
	| { kind: "profile"; profile: string }
	| { kind: "role"; role: string }
	| { kind: "profile-role"; profile: string; role: string }
	| { kind: "invalid"; message: string };

export interface ParseProfileCommandInput {
	args: string;
	profileNames: string[];
	activeProfile?: string;
	activeProfileRoles?: string[];
}

function normalize(value: string): string {
	return value.trim();
}

export function parseProfileCommand(input: ParseProfileCommandInput): ProfileCommandAction {
	const args = normalize(input.args);
	if (args.length === 0) return { kind: "interactive" };
	if (args === "status") return { kind: "status" };
	if (args === "reload") return { kind: "reload" };

	const colonIndex = args.indexOf(":");
	if (colonIndex >= 0) {
		const profile = normalize(args.slice(0, colonIndex));
		const role = normalize(args.slice(colonIndex + 1));
		if (!profile || !role) {
			return { kind: "invalid", message: "Use /profile <profile>:<role>" };
		}
		return { kind: "profile-role", profile, role };
	}

	if (input.profileNames.includes(args)) {
		return { kind: "profile", profile: args };
	}

	if (input.activeProfile && (input.activeProfileRoles ?? []).includes(args)) {
		return { kind: "role", role: args };
	}

	return { kind: "invalid", message: `Unknown profile or role "${args}"` };
}

export function getProfileCommandCompletions(input: {
	prefix: string;
	profileNames: string[];
	activeProfile?: string;
	activeProfileRoles?: string[];
}): AutocompleteItem[] | null {
	const prefix = normalize(input.prefix);
	const values = new Map<string, string>();
	values.set("status", "Show active model profile state");
	values.set("reload", "Reload model profile config from disk");

	for (const profileName of input.profileNames) {
		values.set(profileName, `Activate profile ${profileName}`);
	}

	if (input.activeProfile) {
		for (const roleName of input.activeProfileRoles ?? []) {
			values.set(roleName, `Switch role in ${input.activeProfile}`);
			values.set(`${input.activeProfile}:${roleName}`, `Activate ${input.activeProfile}:${roleName}`);
		}
		values.set(input.activeProfile, `Activate profile ${input.activeProfile}`);
	}

	const completions = Array.from(values.entries())
		.filter(([value]) => value.startsWith(prefix))
		.map(([value, description]) => ({ value, label: value, description }));
	return completions.length > 0 ? completions : null;
}
