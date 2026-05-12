import { readFileSync } from "node:fs";

export type JsonSchema = Record<string, unknown>;

function vendorSchema(name: string): JsonSchema {
	return JSON.parse(readFileSync(new URL(`../vendor/letta/schemas/${name}.json`, import.meta.url), "utf8"));
}

export const readParams = vendorSchema("Read");
export const writeParams = vendorSchema("Write");
export const editParams = vendorSchema("Edit");
export const multiEditParams = vendorSchema("MultiEdit");
export const bashParams = vendorSchema("Bash");
export const globParams = vendorSchema("Glob");
export const grepParams = vendorSchema("Grep");
export const lsParams = vendorSchema("LS");

export const shellCommandParams = vendorSchema("ShellCommand");
export const applyPatchParams = vendorSchema("ApplyPatch");
export const updatePlanParams = vendorSchema("UpdatePlan");
export const viewImageParams = vendorSchema("ViewImage");

export const runShellCommandParams = vendorSchema("RunShellCommandGemini");
export const readFileParams = vendorSchema("ReadFileGemini");
export const readManyFilesParams = vendorSchema("ReadManyFilesGemini");
export const listDirectoryParams = vendorSchema("ListDirectoryGemini");
export const geminiGlobParams = vendorSchema("GlobGemini");
export const searchFileContentParams = vendorSchema("SearchFileContentGemini");
export const replaceParams = vendorSchema("ReplaceGemini");
export const writeFileParams = vendorSchema("WriteFileGemini");
