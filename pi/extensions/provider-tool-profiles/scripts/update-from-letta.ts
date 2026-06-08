import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const LETTA_REPO = "https://github.com/letta-ai/letta-code";
const DEFAULT_REF = "2eca6e1354e37413e5b0840243ac208b8add7bd5";
const ROOT = new URL("..", import.meta.url).pathname;

const FILES = [
	"Bash",
	"Read",
	"Write",
	"Edit",
	"MultiEdit",
	"Glob",
	"Grep",
	"LS",
	"ShellCommand",
	"ExecCommand",
	"WriteStdin",
	"Shell",
	"ReadFileCodex",
	"ListDirCodex",
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
] as const;

async function fetchText(ref: string, path: string): Promise<string> {
	const url = `https://raw.githubusercontent.com/letta-ai/letta-code/${ref}/${path}`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	return response.text();
}

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function main() {
	const ref = process.argv[2] ?? DEFAULT_REF;
	const copied: string[] = [];
	for (const name of FILES) {
		for (const kind of ["schemas", "descriptions"] as const) {
			const ext = kind === "schemas" ? "json" : "md";
			const upstream = `src/tools/${kind}/${name}.${ext}`;
			const content = await fetchText(ref, upstream);
			await write(join(ROOT, "vendor", "letta", kind, `${name}.${ext}`), content);
			copied.push(upstream);
		}
	}

	await write(join(ROOT, "vendor", "letta", "SOURCE.md"), `# Letta Code tool schema snapshot

Upstream: ${LETTA_REPO}
Pinned ref: ${ref}
License: Apache-2.0, see upstream repository for full license text.

This extension vendors selected schema and description files only. Runtime implementations are local Pi wrappers.

Refresh:

\`\`\`bash
bun pi/extensions/provider-tool-profiles/scripts/update-from-letta.ts ${ref}
\`\`\`

Copied files:

${copied.map((file) => `- ${file}`).join("\n")}
`);
}

await main();
