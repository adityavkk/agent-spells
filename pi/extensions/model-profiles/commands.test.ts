import { describe, expect, it } from "bun:test";
import { getProfileCommandCompletions, parseProfileCommand } from "./commands";

describe("parseProfileCommand", () => {
	const profileNames = ["personal", "work"];
	const activeProfile = "personal";
	const activeProfileRoles = ["small", "workhorse", "smart"];

	it("treats empty input as interactive", () => {
		expect(parseProfileCommand({
			args: "   ",
			profileNames,
			activeProfile,
			activeProfileRoles,
		})).toEqual({ kind: "interactive" });
	});

	it("parses status and reload subcommands", () => {
		expect(parseProfileCommand({ args: "status", profileNames, activeProfile, activeProfileRoles })).toEqual({ kind: "status" });
		expect(parseProfileCommand({ args: "reload", profileNames, activeProfile, activeProfileRoles })).toEqual({ kind: "reload" });
	});

	it("parses profile, role, and profile:role targets", () => {
		expect(parseProfileCommand({ args: "work", profileNames, activeProfile, activeProfileRoles })).toEqual({ kind: "profile", profile: "work" });
		expect(parseProfileCommand({ args: "smart", profileNames, activeProfile, activeProfileRoles })).toEqual({ kind: "role", role: "smart" });
		expect(parseProfileCommand({ args: "personal:small", profileNames, activeProfile, activeProfileRoles })).toEqual({
			kind: "profile-role",
			profile: "personal",
			role: "small",
		});
	});

	it("rejects malformed or unknown input", () => {
		expect(parseProfileCommand({ args: "personal:", profileNames, activeProfile, activeProfileRoles })).toEqual({
			kind: "invalid",
			message: "Use /profile <profile>:<role>",
		});
		expect(parseProfileCommand({ args: "unknown", profileNames, activeProfile, activeProfileRoles })).toEqual({
			kind: "invalid",
			message: "Unknown profile or role \"unknown\"",
		});
	});
});

describe("getProfileCommandCompletions", () => {
	it("offers profile, role, and subcommand completions", () => {
		const completions = getProfileCommandCompletions({
			prefix: "s",
			profileNames: ["personal", "work"],
			activeProfile: "personal",
			activeProfileRoles: ["small", "smart"],
		});
		expect(completions?.some((item) => item.value === "status")).toBeTrue();
		expect(completions?.some((item) => item.value === "small")).toBeTrue();
		expect(completions?.some((item) => item.value === "smart")).toBeTrue();
	});

	it("offers profile:role completions for active profile", () => {
		const completions = getProfileCommandCompletions({
			prefix: "personal:",
			profileNames: ["personal"],
			activeProfile: "personal",
			activeProfileRoles: ["small", "smart"],
		});
		expect(completions?.map((item) => item.value)).toEqual(["personal:small", "personal:smart"]);
	});
});
