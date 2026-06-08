import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OUTPUT_DIR = join(process.cwd(), ".tmp", "pi-compat");
const PI_COMPAT_BOUNDARY = join(ROOT, "tools", "pi-compat.ts");

const CURRENT_PACKAGES = {
	codingAgent: "@mariozechner/pi-coding-agent",
	ai: "@mariozechner/pi-ai",
	tui: "@mariozechner/pi-tui",
};

const REQUIRED_CODING_AGENT_EXPORTS = [
	"withFileMutationQueue",
	"truncateHead",
	"truncateTail",
	"truncateLine",
	"formatSize",
	"DEFAULT_MAX_BYTES",
	"DEFAULT_MAX_LINES",
	"createLocalBashOperations",
	"createReadToolDefinition",
	"createWriteToolDefinition",
	"createEditToolDefinition",
	"createBashToolDefinition",
	"createLsToolDefinition",
	"createGrepToolDefinition",
	"createFindToolDefinition",
] as const;

const REQUIRED_TUI_EXPORTS = ["truncateToWidth", "visibleWidth"] as const;
const REQUIRED_COMPAT_EXPORTS = [...REQUIRED_CODING_AGENT_EXPORTS, ...REQUIRED_TUI_EXPORTS] as const;

type CompatMode = "locked" | "latest";

interface Args {
	mode: CompatMode;
	outputDir: string;
	piVersion: string;
	keepTemp: boolean;
}

interface PublicApiEntry {
	name: string;
	present: boolean;
	type: string;
}

interface ImportFinding {
	file: string;
	source: string;
	reason: string;
}

interface SmokeCheck {
	id: string;
	status: "pass" | "fail";
	details?: Record<string, unknown>;
	error?: string;
}

interface SmokeReport {
	mode: CompatMode;
	packages: Record<string, string>;
	publicApi: PublicApiEntry[];
	checks: SmokeCheck[];
	tempDir?: string;
	error?: string;
}

interface SourceReport {
	privateImports: ImportFinding[];
	boundaryViolations: ImportFinding[];
}

function parseArgs(argv: string[]): Args {
	const args: Args = { mode: "locked", outputDir: DEFAULT_OUTPUT_DIR, piVersion: "latest", keepTemp: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--mode") {
			const mode = argv[++i];
			if (mode === "locked" || mode === "latest") args.mode = mode;
			else throw new Error(`Unsupported --mode ${mode ?? ""}; expected locked or latest`);
			continue;
		}
		if (arg === "--output") {
			args.outputDir = argv[++i] ?? args.outputDir;
			continue;
		}
		if (arg === "--pi-version") {
			args.piVersion = argv[++i] ?? args.piVersion;
			continue;
		}
		if (arg === "--keep-temp") {
			args.keepTemp = true;
			continue;
		}
		if (!arg.startsWith("-")) args.mode = arg === "latest" ? "latest" : "locked";
	}
	return args;
}

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8"));
}

async function collectFiles(dir: string, out: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "vendor" || entry.name === "node_modules") continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) await collectFiles(path, out);
		else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

function importSources(source: string): string[] {
	const imports: string[] = [];
	const patterns = [
		/import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
		/export\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g,
		/import\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) imports.push(match[1]!);
	}
	return imports;
}

function isPiPackage(source: string): boolean {
	return source.startsWith("@mariozechner/pi") || source.startsWith("@earendil-works/pi");
}

function privatePiImportReason(source: string): string | undefined {
	if (!isPiPackage(source)) return undefined;
	if (source.includes("/dist/") || source.endsWith("/dist")) return "imports Pi dist internals";
	if (/\/core(?:\/|$)/.test(source)) return "imports Pi core internals";
	if (/\/src(?:\/|$)/.test(source)) return "imports Pi source internals";
	if (/\/modes(?:\/|$)/.test(source)) return "imports Pi mode internals";
	return undefined;
}

async function scanSourceImports(): Promise<SourceReport> {
	const privateImports: ImportFinding[] = [];
	const boundaryViolations: ImportFinding[] = [];
	const files = await collectFiles(ROOT);
	for (const file of files) {
		const relativeFile = relative(process.cwd(), file);
		const source = await readFile(file, "utf8");
		for (const imported of importSources(source)) {
			const privateReason = privatePiImportReason(imported);
			if (privateReason) privateImports.push({ file: relativeFile, source: imported, reason: privateReason });
			if (isPiPackage(imported) && file !== PI_COMPAT_BOUNDARY) {
				boundaryViolations.push({
					file: relativeFile,
					source: imported,
					reason: "direct Pi package import outside tools/pi-compat.ts",
				});
			}
		}
	}
	return { privateImports, boundaryViolations };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function pass(id: string, details?: Record<string, unknown>): SmokeCheck {
	return { id, status: "pass", details };
}

function fail(id: string, error: unknown, details?: Record<string, unknown>): SmokeCheck {
	return { id, status: "fail", error: errorText(error), details };
}

function publicApiEntries(api: Record<string, unknown>, names: readonly string[]): PublicApiEntry[] {
	return names.map((name) => ({ name, present: typeof api[name] !== "undefined", type: typeof api[name] }));
}

async function runLockedSmoke(): Promise<SmokeReport> {
	const api = await import(pathToFileURL(PI_COMPAT_BOUNDARY).href) as Record<string, any>;
	return runSmoke("locked", CURRENT_PACKAGES, api);
}

async function runSmoke(mode: CompatMode, packages: Record<string, string>, api: Record<string, any>): Promise<SmokeReport> {
	const publicApi = publicApiEntries(api, REQUIRED_COMPAT_EXPORTS);
	const checks: SmokeCheck[] = [];

	const missing = publicApi.filter((entry) => !entry.present);
	checks.push(missing.length === 0 ? pass("public-exports") : fail("public-exports", `Missing exports: ${missing.map((entry) => entry.name).join(", ")}`));

	try {
		const truncation = api.truncateHead("one\ntwo\nthree", { maxLines: 2, maxBytes: 1000 });
		if (!truncation.truncated || truncation.totalLines !== 3) throw new Error("truncateHead did not expose expected truncation metadata");
		const line = api.truncateLine("abcdef", 3);
		if (!line.wasTruncated) throw new Error("truncateLine did not report truncation");
		if (api.formatSize(1024) !== "1.0KB") throw new Error("formatSize output changed unexpectedly");
		checks.push(pass("truncation-utilities", { totalLines: truncation.totalLines, outputLines: truncation.outputLines }));
	} catch (error) {
		checks.push(fail("truncation-utilities", error));
	}

	let tempDir: string | undefined;
	try {
		tempDir = await mkdtemp(join(tmpdir(), "provider-pi-compat-"));
		const queuedPath = join(tempDir, "queued.txt");
		await api.withFileMutationQueue(queuedPath, async () => writeFile(queuedPath, "queued", "utf8"));
		checks.push(pass("file-mutation-queue"));
	} catch (error) {
		checks.push(fail("file-mutation-queue", error));
	}

	try {
		if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "provider-pi-compat-"));
		const factories: Array<[string, string]> = [
			["read", "createReadToolDefinition"],
			["write", "createWriteToolDefinition"],
			["edit", "createEditToolDefinition"],
			["bash", "createBashToolDefinition"],
			["ls", "createLsToolDefinition"],
			["grep", "createGrepToolDefinition"],
			["find", "createFindToolDefinition"],
		];
		for (const [expectedName, factoryName] of factories) {
			const factory = api[factoryName];
			if (typeof factory !== "function") throw new Error(`${factoryName} is not a function`);
			const definition = factory(tempDir);
			if (definition.name !== expectedName) throw new Error(`${factoryName} returned ${definition.name}, expected ${expectedName}`);
			if (typeof definition.execute !== "function") throw new Error(`${factoryName} did not return executable tool definition`);
		}
		checks.push(pass("native-tool-definition-factories", { count: factories.length }));
	} catch (error) {
		checks.push(fail("native-tool-definition-factories", error));
	}

	try {
		if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "provider-pi-compat-"));
		const ctx = { cwd: tempDir, model: { input: ["text"] } };
		const writeTool = api.createWriteToolDefinition(tempDir);
		const readTool = api.createReadToolDefinition(tempDir);
		await writeTool.execute("pi-compat-write", { path: "smoke.txt", content: "hello\n" }, undefined, undefined, ctx);
		const readResult = await readTool.execute("pi-compat-read", { path: "smoke.txt" }, undefined, undefined, ctx);
		const text = readResult.content?.find((item: any) => item.type === "text")?.text;
		if (text !== "hello\n") throw new Error(`native read/write returned unexpected text: ${JSON.stringify(text)}`);
		checks.push(pass("native-read-write-smoke"));
	} catch (error) {
		checks.push(fail("native-read-write-smoke", error));
	}

	try {
		if (!tempDir) tempDir = await mkdtemp(join(tmpdir(), "provider-pi-compat-"));
		let output = "";
		const operations = api.createLocalBashOperations();
		const result = await operations.exec("printf pi-compat", tempDir, {
			onData: (chunk: Buffer) => { output += chunk.toString("utf8"); },
			timeout: 10_000,
		});
		if (result.exitCode !== 0 || output !== "pi-compat") throw new Error(`unexpected shell result exit=${result.exitCode} output=${JSON.stringify(output)}`);
		checks.push(pass("local-bash-operations-smoke", { exitCode: result.exitCode }));
	} catch (error) {
		checks.push(fail("local-bash-operations-smoke", error));
	}

	return { mode, packages, publicApi, checks, tempDir };
}

function latestSmokeScript(piVersion: string, outputPath: string): string {
	const script = `
import { writeFile } from "node:fs/promises";
import * as codingAgent from "${CURRENT_PACKAGES.codingAgent}";
import * as tui from "${CURRENT_PACKAGES.tui}";

const requiredCodingAgentExports = ${JSON.stringify(REQUIRED_CODING_AGENT_EXPORTS)};
const requiredTuiExports = ${JSON.stringify(REQUIRED_TUI_EXPORTS)};
const api = { ...codingAgent, ...tui };
const publicApi = [...requiredCodingAgentExports, ...requiredTuiExports].map((name) => ({ name, present: typeof api[name] !== "undefined", type: typeof api[name] }));
const checks = [];
const pass = (id, details) => checks.push({ id, status: "pass", details });
const fail = (id, error, details) => checks.push({ id, status: "fail", error: error instanceof Error ? error.message : String(error), details });

try {
  const missing = publicApi.filter((entry) => !entry.present);
  if (missing.length) throw new Error(
    "Missing exports: " + missing.map((entry) => entry.name).join(", ")
  );
  pass("public-exports");
} catch (error) { fail("public-exports", error); }

try {
  const truncation = codingAgent.truncateHead("one\\ntwo\\nthree", { maxLines: 2, maxBytes: 1000 });
  if (!truncation.truncated || truncation.totalLines !== 3) throw new Error("truncateHead metadata changed");
  const line = codingAgent.truncateLine("abcdef", 3);
  if (!line.wasTruncated) throw new Error("truncateLine metadata changed");
  pass("truncation-utilities", { totalLines: truncation.totalLines });
} catch (error) { fail("truncation-utilities", error); }

try {
  const defs = [
    ["read", codingAgent.createReadToolDefinition],
    ["write", codingAgent.createWriteToolDefinition],
    ["edit", codingAgent.createEditToolDefinition],
    ["bash", codingAgent.createBashToolDefinition],
    ["ls", codingAgent.createLsToolDefinition],
    ["grep", codingAgent.createGrepToolDefinition],
    ["find", codingAgent.createFindToolDefinition],
  ];
  for (const [expected, factory] of defs) {
    const definition = factory(process.cwd());
    if (definition.name !== expected) throw new Error(\`expected \${expected}, got \${definition.name}\`);
    if (typeof definition.execute !== "function") throw new Error(\`\${expected} execute missing\`);
  }
  pass("native-tool-definition-factories", { count: defs.length });
} catch (error) { fail("native-tool-definition-factories", error); }

try {
  const cwd = process.cwd();
  const ctx = { cwd, model: { input: ["text"] } };
  const writeTool = codingAgent.createWriteToolDefinition(cwd);
  const readTool = codingAgent.createReadToolDefinition(cwd);
  await writeTool.execute("pi-compat-write", { path: "smoke.txt", content: "hello\\n" }, undefined, undefined, ctx);
  const readResult = await readTool.execute("pi-compat-read", { path: "smoke.txt" }, undefined, undefined, ctx);
  const text = readResult.content?.find((item) => item.type === "text")?.text;
  if (text !== "hello\\n") throw new Error("native read/write returned unexpected text: " + JSON.stringify(text));
  pass("native-read-write-smoke");
} catch (error) { fail("native-read-write-smoke", error); }

try {
  let output = "";
  const operations = codingAgent.createLocalBashOperations();
  const result = await operations.exec("printf pi-compat", process.cwd(), {
    onData: (chunk) => { output += chunk.toString("utf8"); },
    timeout: 10000,
  });
  if (result.exitCode !== 0 || output !== "pi-compat") throw new Error(\`unexpected shell result exit=\${result.exitCode} output=\${JSON.stringify(output)}\`);
  pass("local-bash-operations-smoke", { exitCode: result.exitCode });
} catch (error) { fail("local-bash-operations-smoke", error); }

await writeFile(${JSON.stringify(outputPath)}, JSON.stringify({
  mode: "latest",
  packages: {
    codingAgent: "${CURRENT_PACKAGES.codingAgent}@${piVersion}",
    ai: "${CURRENT_PACKAGES.ai}@${piVersion}",
    tui: "${CURRENT_PACKAGES.tui}@${piVersion}",
  },
  publicApi,
  checks,
}, null, 2) + "\\n");
`;
	return script.trimStart();
}

async function runCommand(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { ok: code === 0, output: `${stdout}${stderr}` };
}

async function runLatestSmoke(args: Args): Promise<SmokeReport> {
	const tempDir = await mkdtemp(join(tmpdir(), "provider-pi-compat-latest-"));
	const outputPath = join(tempDir, "latest-smoke.json");
	try {
		await writeFile(join(tempDir, "package.json"), `${JSON.stringify({
			private: true,
			type: "module",
			dependencies: {
				[CURRENT_PACKAGES.codingAgent]: args.piVersion,
				[CURRENT_PACKAGES.ai]: args.piVersion,
				[CURRENT_PACKAGES.tui]: args.piVersion,
			},
		}, null, 2)}\n`, "utf8");
		await writeFile(join(tempDir, "smoke.ts"), latestSmokeScript(args.piVersion, outputPath), "utf8");

		const install = await runCommand(["bun", "install", "--silent"], tempDir);
		if (!install.ok) throw new Error(`latest Pi install failed:\n${install.output}`);
		const smoke = await runCommand(["bun", "run", "smoke.ts"], tempDir);
		if (!smoke.ok) throw new Error(`latest Pi smoke failed:\n${smoke.output}`);
		const report = await readJson<SmokeReport>(outputPath);
		report.tempDir = tempDir;
		return report;
	} catch (error) {
		return {
			mode: "latest",
			packages: {
				codingAgent: `${CURRENT_PACKAGES.codingAgent}@${args.piVersion}`,
				ai: `${CURRENT_PACKAGES.ai}@${args.piVersion}`,
				tui: `${CURRENT_PACKAGES.tui}@${args.piVersion}`,
			},
			publicApi: [],
			checks: [fail("latest-install-or-smoke", error)],
			tempDir,
			error: errorText(error),
		};
	} finally {
		if (!args.keepTemp) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

function renderFindings(findings: ImportFinding[]): string {
	return findings.length === 0
		? "- none"
		: findings.map((finding) => `- ${finding.file}: ${finding.source} (${finding.reason})`).join("\n");
}

function hasFailures(smoke: SmokeReport, source: SourceReport): boolean {
	return source.privateImports.length > 0
		|| source.boundaryViolations.length > 0
		|| smoke.publicApi.some((entry) => !entry.present)
		|| smoke.checks.some((check) => check.status === "fail");
}

function renderSummary(smoke: SmokeReport, source: SourceReport): string {
	const failedChecks = smoke.checks.filter((check) => check.status === "fail");
	const missingExports = smoke.publicApi.filter((entry) => !entry.present);
	return `# Pi compatibility report

- Mode: ${smoke.mode}
- Generated: ${new Date().toISOString()}
- Provider extension root: ${relative(process.cwd(), ROOT)}
- Pi import boundary: ${relative(process.cwd(), PI_COMPAT_BOUNDARY)}
- Packages:
${Object.entries(smoke.packages).map(([name, value]) => `  - ${name}: ${value}`).join("\n")}

## Public API exports

${missingExports.length === 0 ? "- all required exports present" : missingExports.map((entry) => `- missing: ${entry.name}`).join("\n")}

## Source import policy

- Private Pi imports: ${source.privateImports.length}
- Direct Pi imports outside boundary: ${source.boundaryViolations.length}

## Native tool smoke

${smoke.checks.map((check) => `- ${check.status === "pass" ? "pass" : "fail"}: ${check.id}${check.error ? ` — ${check.error}` : ""}`).join("\n")}

## Risk summary

${failedChecks.length === 0 && missingExports.length === 0 ? `- ${smoke.mode === "locked" ? "Locked" : "Canary"} public Pi APIs and native smoke checks are green.` : `- ${failedChecks.length} smoke check(s) failed and ${missingExports.length} required export(s) are missing.`}
${source.privateImports.length === 0 ? "- No private Pi imports detected." : "- Private Pi imports detected; remove them."}
${source.boundaryViolations.length === 0 ? "- Pi package imports are isolated to tools/pi-compat.ts." : "- Direct Pi package imports bypass the compatibility boundary."}
`;
}

function renderRecommendedActions(smoke: SmokeReport, source: SourceReport): string {
	const actions: string[] = [];
	if (source.privateImports.length > 0) actions.push("Remove private Pi imports. Use only top-level public package entrypoints through `tools/pi-compat.ts`.");
	if (source.boundaryViolations.length > 0) actions.push("Move direct Pi package imports into `tools/pi-compat.ts` and import from that boundary elsewhere.");
	if (smoke.publicApi.some((entry) => !entry.present)) actions.push("Update `tools/pi-compat.ts` or adapter design for missing public Pi exports before changing runtime behavior.");
	for (const check of smoke.checks.filter((item) => item.status === "fail")) {
		actions.push(`Investigate Pi compatibility smoke failure: ${check.id}.`);
	}
	if (actions.length === 0) actions.push("No action needed.");
	return `# Recommended actions\n\n${actions.map((action) => `- ${action}`).join("\n")}\n`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const source = await scanSourceImports();
	const smoke = args.mode === "latest" ? await runLatestSmoke(args) : await runLockedSmoke();

	await write(join(args.outputDir, "public-api.json"), `${JSON.stringify({ mode: smoke.mode, packages: smoke.packages, exports: smoke.publicApi }, null, 2)}\n`);
	await write(join(args.outputDir, "private-imports.txt"), `# Private Pi imports\n\n${renderFindings(source.privateImports)}\n\n# Direct Pi imports outside tools/pi-compat.ts\n\n${renderFindings(source.boundaryViolations)}\n`);
	await write(join(args.outputDir, "native-tool-smoke.json"), `${JSON.stringify({ mode: smoke.mode, packages: smoke.packages, checks: smoke.checks, tempDir: smoke.tempDir, error: smoke.error }, null, 2)}\n`);
	await write(join(args.outputDir, "summary.md"), renderSummary(smoke, source));
	await write(join(args.outputDir, "recommended-actions.md"), renderRecommendedActions(smoke, source));

	const failed = hasFailures(smoke, source);
	console.log(`Wrote Pi compatibility report to ${args.outputDir}`);
	console.log(`mode=${smoke.mode} failed=${failed ? 1 : 0} privateImports=${source.privateImports.length} boundaryViolations=${source.boundaryViolations.length} smokeFailures=${smoke.checks.filter((check) => check.status === "fail").length}`);
	if (failed) process.exitCode = 1;
}

await main();
