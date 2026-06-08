import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyPatchParams,
	execCommandParams,
	listDirCodexParams,
	readFileCodexParams,
	readFileParams,
	readParams,
	shellCommandParams,
	shellParams,
	writeFileParams,
	writeStdinParams,
} from "./schemas";

const vendor = join(import.meta.dir, "..", "vendor", "letta", "schemas");

function schema(name: string): any {
	return JSON.parse(readFileSync(join(vendor, `${name}.json`), "utf8"));
}

describe("vendored Letta schema snapshot", () => {
	it("contains expected Claude core schemas", () => {
		expect(schema("Read").required).toEqual(["file_path"]);
		expect(schema("Edit").properties.old_string.type).toBe("string");
		expect(schema("MultiEdit").properties.edits.items.required).toEqual(["old_string", "new_string"]);
	});

	it("contains expected Codex schemas", () => {
		expect(schema("ShellCommand").required).toEqual(["command"]);
		expect(schema("ExecCommand").required).toEqual(["cmd"]);
		expect(schema("WriteStdin").required).toEqual(["session_id"]);
		expect(schema("Shell").required).toEqual(["command"]);
		expect(schema("ReadFileCodex").required).toEqual(["file_path"]);
		expect(schema("ListDirCodex").required).toEqual(["dir_path"]);
		expect(schema("ApplyPatch").required).toEqual(["input"]);
		expect(schema("UpdatePlan").properties.plan.items.required).toEqual(["step", "status"]);
	});

	it("contains expected Gemini schemas", () => {
		expect(schema("RunShellCommandGemini").required).toEqual(["command"]);
		expect(schema("ReadManyFilesGemini").required).toEqual(["include"]);
		expect(schema("ReplaceGemini").properties.expected_replacements.minimum).toBe(1);
	});

	it("exports registered parameters from the vendored snapshot", () => {
		expect(readParams).toEqual(schema("Read"));
		expect(shellCommandParams).toEqual(schema("ShellCommand"));
		expect(execCommandParams).toEqual(schema("ExecCommand"));
		expect(writeStdinParams).toEqual(schema("WriteStdin"));
		expect(shellParams).toEqual(schema("Shell"));
		expect(readFileCodexParams).toEqual(schema("ReadFileCodex"));
		expect(listDirCodexParams).toEqual(schema("ListDirCodex"));
		expect(applyPatchParams).toEqual(schema("ApplyPatch"));
		expect(readFileParams).toEqual(schema("ReadFileGemini"));
		expect(writeFileParams).toEqual(schema("WriteFileGemini"));
	});
});
