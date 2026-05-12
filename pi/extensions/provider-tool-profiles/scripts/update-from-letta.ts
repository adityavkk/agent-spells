import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const LETTA_REPO = "https://github.com/letta-ai/letta-code";
const LETTA_COMMIT = "32e042d5";
const RAW_BASE = `https://raw.githubusercontent.com/letta-ai/letta-code/${LETTA_COMMIT}/src/tools`;

const files = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"Glob",
	"Grep",
	"LS",
	"ShellCommand",
	"ApplyPatch",
	"UpdatePlan",
	"ViewImage",
	"RunShellCommandGemini",
	"ReadFileGemini",
	"ReadManyFilesGemini",
	"ListDirectoryGemini",
	"GlobGemini",
	"SearchFileContentGemini",
	"ReplaceGemini",
	"WriteFileGemini",
];

const root = path.resolve(import.meta.dir, "..");
const vendorRoot = path.join(root, "vendor", "letta");

async function fetchText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}

async function main(): Promise<void> {
	await mkdir(path.join(vendorRoot, "schemas"), { recursive: true });
	await mkdir(path.join(vendorRoot, "descriptions"), { recursive: true });

	for (const name of files) {
		const [schema, description] = await Promise.all([
			fetchText(`${RAW_BASE}/schemas/${name}.json`),
			fetchText(`${RAW_BASE}/descriptions/${name}.md`),
		]);
		await writeFile(path.join(vendorRoot, "schemas", `${name}.json`), `${schema.trim()}\n`, "utf-8");
		await writeFile(path.join(vendorRoot, "descriptions", `${name}.md`), `${description.trim()}\n`, "utf-8");
	}

	await writeFile(path.join(vendorRoot, "SOURCE.md"), [
		"# Letta Code Tool Assets",
		"",
		`Upstream: ${LETTA_REPO}`,
		`Pinned commit: \`${LETTA_COMMIT}\``,
		"License: Apache-2.0",
		"",
		"These schemas and descriptions are copied from Letta Code and used as reference snapshots for provider-native Pi tool profiles.",
		"",
		"Refresh command:",
		"",
		"```bash",
		"bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts",
		"```",
		"",
		"Copied files:",
		"",
		...files.flatMap((name) => [
			`- \`src/tools/schemas/${name}.json\``,
			`- \`src/tools/descriptions/${name}.md\``,
		]),
		"",
	].join("\n"), "utf-8");
}

await main();

