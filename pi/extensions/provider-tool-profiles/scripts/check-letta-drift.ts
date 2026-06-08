import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST_PATH = join(ROOT, "vendor", "letta", "tool-manifest.json");
const TOOLSET_SNAPSHOT_PATH = join(ROOT, "vendor", "letta", "default-toolsets.json");
const DEFAULT_OUTPUT_DIR = join(process.cwd(), ".tmp", "letta-drift");

type LettaToolStatus = "active" | "registered" | "vendored" | "blocked" | "ignored";

interface LettaToolManifestEntry {
	upstreamName: string;
	provider: string;
	modelNames?: string[];
	status?: LettaToolStatus;
	capabilities?: string[];
	decision?: string;
	files?: string[];
}

interface LettaToolManifest {
	upstream: string;
	ref: string;
	tools: LettaToolManifestEntry[];
}

interface Args {
	ref: string;
	outputDir: string;
	updateToolsetSnapshot: boolean;
}

interface RawFetchResult {
	status: number;
	content?: string;
}

interface ChangedVendoredFile {
	tool: string;
	provider: string;
	status: LettaToolStatus;
	file: string;
	kind: "schema" | "description" | "other";
	risk: "deleted-upstream" | "active-schema-review" | "inactive-schema" | "description" | "other";
}

interface ToolsetSnapshot {
	upstream: string;
	ref: string;
	toolsets: Record<string, string[]>;
}

interface ToolsetDiff {
	name: string;
	added: string[];
	removed: string[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = { ref: "main", outputDir: DEFAULT_OUTPUT_DIR, updateToolsetSnapshot: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--ref") {
			args.ref = argv[++i] ?? args.ref;
			continue;
		}
		if (arg === "--output") {
			args.outputDir = argv[++i] ?? args.outputDir;
			continue;
		}
		if (arg === "--update-toolset-snapshot") {
			args.updateToolsetSnapshot = true;
			continue;
		}
		if (!arg.startsWith("-")) args.ref = arg;
	}
	return args;
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function tryReadJson<T>(path: string): Promise<T | undefined> {
	try {
		return await readJson<T>(path);
	} catch {
		return undefined;
	}
}

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

function rawUrl(ref: string, path: string): string {
	return `https://raw.githubusercontent.com/letta-ai/letta-code/${ref}/${path}`;
}

async function fetchRaw(ref: string, path: string): Promise<RawFetchResult> {
	const response = await fetch(rawUrl(ref, path));
	if (!response.ok) return { status: response.status };
	return { status: response.status, content: await response.text() };
}

async function fetchTreePaths(ref: string): Promise<string[]> {
	const response = await fetch(`https://api.github.com/repos/letta-ai/letta-code/git/trees/${ref}?recursive=1`, {
		headers: { Accept: "application/vnd.github+json" },
	});
	if (!response.ok) throw new Error(`Failed to fetch Letta tree ${ref}: ${response.status} ${response.statusText}`);
	const data = await response.json() as { tree?: Array<{ path?: string; type?: string }> };
	return (data.tree ?? []).filter((entry) => entry.type === "blob" && entry.path).map((entry) => entry.path!);
}

function filesForTool(tool: LettaToolManifestEntry): string[] {
	return tool.files ?? [`schemas/${tool.upstreamName}.json`, `descriptions/${tool.upstreamName}.md`];
}

function schemaName(path: string): string {
	return basename(path, ".json");
}

function kindForFile(file: string): ChangedVendoredFile["kind"] {
	if (file.startsWith("schemas/")) return "schema";
	if (file.startsWith("descriptions/")) return "description";
	return "other";
}

function riskForChange(tool: LettaToolManifestEntry, file: string, deleted: boolean): ChangedVendoredFile["risk"] {
	if (deleted) return "deleted-upstream";
	const kind = kindForFile(file);
	if (kind === "description") return "description";
	if (kind === "schema") return tool.status === "active" ? "active-schema-review" : "inactive-schema";
	return "other";
}

function extractArray(source: string, name: string): string[] {
	const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*:[^=]+=[\\s\\S]*?\\[([\\s\\S]*?)\\];`));
	if (!match) return [];
	const withoutComments = match[1]
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
	return [...withoutComments.matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function extractToolsets(managerSource: string): Record<string, string[]> {
	const names = [
		"ANTHROPIC_DEFAULT_TOOLS",
		"OPENAI_DEFAULT_TOOLS",
		"GEMINI_DEFAULT_TOOLS",
		"OPENAI_PASCAL_TOOLS",
		"GEMINI_PASCAL_TOOLS",
	];
	return Object.fromEntries(names.map((name) => [name, extractArray(managerSource, name)]));
}

function diffToolsets(previous: Record<string, string[]> | undefined, next: Record<string, string[]>): ToolsetDiff[] {
	if (!previous) return [];
	const names = new Set([...Object.keys(previous), ...Object.keys(next)]);
	return [...names].sort().map((name) => {
		const before = new Set(previous[name] ?? []);
		const after = new Set(next[name] ?? []);
		return {
			name,
			added: [...after].filter((tool) => !before.has(tool)).sort(),
			removed: [...before].filter((tool) => !after.has(tool)).sort(),
		};
	}).filter((diff) => diff.added.length > 0 || diff.removed.length > 0);
}

function renderList(items: string[]): string {
	return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

function renderSummary(options: {
	manifest: LettaToolManifest;
	ref: string;
	changedFiles: ChangedVendoredFile[];
	newSchemas: string[];
	toolsetDiffs: ToolsetDiff[];
}): string {
	const risky = options.changedFiles.filter((file) => file.risk === "active-schema-review" || file.risk === "deleted-upstream");
	const descriptionOnly = options.changedFiles.length > 0 && options.changedFiles.every((file) => file.risk === "description");
	const snapshotLine = options.changedFiles.length === 0
		? "- No vendored file drift detected."
		: descriptionOnly
			? "- Snapshot refresh appears description-only."
			: "- Snapshot refresh includes schema or non-description changes.";
	return `# Letta drift report

- Upstream: ${options.manifest.upstream}
- Current manifest ref: ${options.manifest.ref}
- Checked ref: ${options.ref}
- Generated: ${new Date().toISOString()}

## Changed vendored files

${renderList(options.changedFiles.map((file) => `${file.file} (${file.tool}, ${file.provider}, ${file.status}, ${file.risk})`))}

## New upstream schemas not in manifest

${renderList(options.newSchemas)}

## Upstream default toolset changes vs snapshot

${options.toolsetDiffs.length === 0 ? "- none" : options.toolsetDiffs.map((diff) => [`- ${diff.name}`, `  - added: ${diff.added.join(", ") || "none"}`, `  - removed: ${diff.removed.join(", ") || "none"}`].join("\n")).join("\n")}

## Risk summary

${risky.length > 0 ? `- Review required: ${risky.length} active/deleted schema changes.` : "- No active schema deletions or active schema diffs detected."}
${options.toolsetDiffs.length > 0 ? "- Design review required: upstream default toolsets changed." : "- No upstream default toolset drift detected."}
${snapshotLine}
`;
}

function renderRecommendedActions(options: { changedFiles: ChangedVendoredFile[]; newSchemas: string[]; toolsetDiffs: ToolsetDiff[] }): string {
	const actions: string[] = [];
	if (options.changedFiles.some((file) => file.risk === "active-schema-review")) {
		actions.push("Review active schema changes against local wrapper params and add/update tests before refreshing.");
	}
	if (options.changedFiles.length > 0 && options.changedFiles.every((file) => file.risk === "description")) {
		actions.push("Safe candidate for snapshot-only refresh: descriptions changed, no active schema drift.");
	}
	if (options.newSchemas.length > 0) {
		actions.push("Classify new upstream schemas in `vendor/letta/tool-manifest.json` as active, vendored, blocked, or ignored.");
	}
	if (options.toolsetDiffs.length > 0) {
		actions.push("Do not auto-activate changed upstream defaults. Update compatibility decisions and open a design issue if semantics changed.");
	}
	if (actions.length === 0) actions.push("No action needed.");
	return `# Recommended actions\n\n${actions.map((action) => `- ${action}`).join("\n")}\n`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const manifest = await readJson<LettaToolManifest>(MANIFEST_PATH);
	const treePaths = await fetchTreePaths(args.ref);
	const upstreamSchemaNames = treePaths
		.filter((path) => path.startsWith("src/tools/schemas/") && path.endsWith(".json"))
		.map(schemaName)
		.sort();
	const manifestSchemaNames = new Set(manifest.tools.map((tool) => tool.upstreamName));
	const newSchemas = upstreamSchemaNames.filter((name) => !manifestSchemaNames.has(name));

	const changedFiles: ChangedVendoredFile[] = [];
	for (const tool of manifest.tools) {
		if (tool.status === "ignored") continue;
		for (const file of filesForTool(tool)) {
			const upstream = await fetchRaw(args.ref, `src/tools/${file}`);
			const localPath = join(ROOT, "vendor", "letta", file);
			let localContent = "";
			try {
				localContent = await readFile(localPath, "utf8");
			} catch {
				localContent = "";
			}
			if (upstream.status !== 200 || upstream.content !== localContent) {
				changedFiles.push({
					tool: tool.upstreamName,
					provider: tool.provider,
					status: tool.status ?? "vendored",
					file,
					kind: kindForFile(file),
					risk: riskForChange(tool, file, upstream.status !== 200),
				});
			}
		}
	}

	const manager = await fetchRaw(args.ref, "src/tools/manager.ts");
	if (manager.status !== 200 || !manager.content) throw new Error(`Failed to fetch src/tools/manager.ts at ${args.ref}`);
	const toolsetSnapshot: ToolsetSnapshot = { upstream: manifest.upstream, ref: args.ref, toolsets: extractToolsets(manager.content) };
	const previousSnapshot = await tryReadJson<ToolsetSnapshot>(TOOLSET_SNAPSHOT_PATH);
	const toolsetDiffs = diffToolsets(previousSnapshot?.toolsets, toolsetSnapshot.toolsets);

	await write(join(args.outputDir, "changed-vendored-files.json"), `${JSON.stringify(changedFiles, null, 2)}\n`);
	await write(join(args.outputDir, "new-upstream-tools.json"), `${JSON.stringify({ ref: args.ref, schemas: newSchemas }, null, 2)}\n`);
	await write(join(args.outputDir, "default-toolsets.json"), `${JSON.stringify(toolsetSnapshot, null, 2)}\n`);
	await write(join(args.outputDir, "summary.md"), renderSummary({ manifest, ref: args.ref, changedFiles, newSchemas, toolsetDiffs }));
	await write(join(args.outputDir, "recommended-actions.md"), renderRecommendedActions({ changedFiles, newSchemas, toolsetDiffs }));

	if (args.updateToolsetSnapshot) {
		await write(TOOLSET_SNAPSHOT_PATH, `${JSON.stringify(toolsetSnapshot, null, 2)}\n`);
	}

	console.log(`Wrote Letta drift report to ${args.outputDir}`);
	console.log(`changed=${changedFiles.length} newSchemas=${newSchemas.length} toolsetDiffs=${toolsetDiffs.length}`);
}

await main();