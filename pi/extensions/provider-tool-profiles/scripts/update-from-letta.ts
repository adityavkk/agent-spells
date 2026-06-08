import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LETTA_REPO = "https://github.com/letta-ai/letta-code";
const DEFAULT_REF = "2eca6e1354e37413e5b0840243ac208b8add7bd5";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(ROOT, "vendor", "letta", "tool-manifest.json");

type LettaToolStatus = "active" | "registered" | "vendored" | "blocked" | "ignored";

interface LettaToolManifestEntry {
	upstreamName: string;
	status?: LettaToolStatus;
	files?: string[];
}

interface LettaToolManifest {
	upstream: string;
	ref: string;
	tools: LettaToolManifestEntry[];
}

interface Args {
	ref?: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--ref") {
			args.ref = argv[++i];
			continue;
		}
		if (arg === "--from-manifest") continue;
		if (!arg.startsWith("-") && !args.ref) args.ref = arg;
	}
	return args;
}

async function readManifest(): Promise<LettaToolManifest> {
	return JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
}

async function writeManifest(manifest: LettaToolManifest): Promise<void> {
	await write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
}

function filesForTool(tool: LettaToolManifestEntry): string[] {
	return tool.files ?? [`schemas/${tool.upstreamName}.json`, `descriptions/${tool.upstreamName}.md`];
}

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
	const args = parseArgs(process.argv.slice(2));
	const manifest = await readManifest();
	const ref = args.ref ?? manifest.ref ?? DEFAULT_REF;
	const copied: string[] = [];
	for (const tool of manifest.tools) {
		if (tool.status === "ignored") continue;
		for (const file of filesForTool(tool)) {
			const upstream = `src/tools/${file}`;
			const content = await fetchText(ref, upstream);
			await write(join(ROOT, "vendor", "letta", file), content);
			copied.push(upstream);
		}
	}
	if (manifest.ref !== ref) {
		await writeManifest({ ...manifest, ref });
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
