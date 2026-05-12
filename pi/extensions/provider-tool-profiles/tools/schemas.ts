import { Type } from "typebox";

const strict = { additionalProperties: false } as const;

export const readParams = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to read" }),
	offset: Type.Optional(Type.Number({ description: "The line number to start reading from" })),
	limit: Type.Optional(Type.Number({ description: "The number of lines to read" })),
}, strict);

export const writeParams = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to write" }),
	content: Type.String({ description: "The content to write to the file" }),
}, strict);

export const editParams = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to modify" }),
	old_string: Type.String({ description: "The exact text to replace" }),
	new_string: Type.String({ description: "The replacement text" }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurrences of old_string" })),
}, strict);

export const multiEditParams = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to modify" }),
	edits: Type.Array(Type.Object({
		old_string: Type.String({ description: "The exact text to replace" }),
		new_string: Type.String({ description: "The replacement text" }),
		replace_all: Type.Optional(Type.Boolean({ description: "Replace all occurrences of old_string" })),
	}, strict), { minItems: 1 }),
}, strict);

export const bashParams = Type.Object({
	command: Type.String({ description: "The command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds, max 600000" })),
	description: Type.Optional(Type.String({ description: "Concise description of what this command does" })),
	run_in_background: Type.Optional(Type.Boolean({ description: "Unsupported in this extension v1" })),
}, strict);

export const globParams = Type.Object({
	pattern: Type.String({ description: "The glob pattern to match files against" }),
	path: Type.Optional(Type.String({ description: "Directory to search; defaults to cwd" })),
}, strict);

export const grepParams = Type.Object({
	pattern: Type.String({ description: "Regular expression pattern to search for" }),
	path: Type.Optional(Type.String({ description: "File or directory to search; defaults to cwd" })),
	glob: Type.Optional(Type.String({ description: "Glob pattern to filter files" })),
	output_mode: Type.Optional(Type.String({ description: "content, files_with_matches, or count" })),
	"-B": Type.Optional(Type.Number()),
	"-A": Type.Optional(Type.Number()),
	"-C": Type.Optional(Type.Number()),
	context: Type.Optional(Type.Number()),
	"-n": Type.Optional(Type.Boolean()),
	"-i": Type.Optional(Type.Boolean()),
	type: Type.Optional(Type.String()),
	head_limit: Type.Optional(Type.Number()),
	offset: Type.Optional(Type.Number()),
	multiline: Type.Optional(Type.Boolean()),
}, strict);

export const lsParams = Type.Object({
	path: Type.String({ description: "The directory to list" }),
	ignore: Type.Optional(Type.Array(Type.String(), { description: "Optional glob patterns to ignore" })),
}, strict);

export const shellCommandParams = Type.Object({
	command: Type.String({ description: "The shell script to execute" }),
	workdir: Type.Optional(Type.String({ description: "Working directory" })),
	login: Type.Optional(Type.Boolean({ description: "Accepted for Codex compatibility; ignored" })),
	timeout_ms: Type.Optional(Type.Number({ description: "Timeout in milliseconds" })),
	sandbox_permissions: Type.Optional(Type.String({ description: "Accepted for Codex compatibility" })),
	justification: Type.Optional(Type.String({ description: "Accepted for Codex compatibility" })),
	prefix_rule: Type.Optional(Type.Array(Type.String(), { description: "Accepted for Codex compatibility" })),
}, strict);

export const applyPatchParams = Type.Object({
	input: Type.String({ description: "The entire apply_patch command, including Begin/End Patch markers" }),
}, strict);

export const updatePlanParams = Type.Object({
	explanation: Type.Optional(Type.String()),
	plan: Type.Array(Type.Object({
		step: Type.String(),
		status: Type.String({ description: "pending, in_progress, or completed" }),
	}, strict)),
}, strict);

export const viewImageParams = Type.Object({
	path: Type.String({ description: "Local filesystem path to an image file" }),
}, strict);

export const runShellCommandParams = Type.Object({
	command: Type.String({ description: "Exact bash command to execute" }),
	description: Type.Optional(Type.String({ description: "Brief user-facing command description" })),
	dir_path: Type.Optional(Type.String({ description: "Directory to run in; defaults to cwd" })),
}, strict);

export const readManyFilesParams = Type.Object({
	include: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
	exclude: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	recursive: Type.Optional(Type.Boolean()),
	useDefaultExcludes: Type.Optional(Type.Boolean()),
	file_filtering_options: Type.Optional(Type.Object({
		respect_git_ignore: Type.Optional(Type.Boolean()),
		respect_gemini_ignore: Type.Optional(Type.Boolean()),
	}, strict)),
}, strict);

export const listDirectoryParams = Type.Object({
	dir_path: Type.String({ description: "Directory to list" }),
	ignore: Type.Optional(Type.Array(Type.String())),
	file_filtering_options: Type.Optional(Type.Object({
		respect_git_ignore: Type.Optional(Type.Boolean()),
		respect_gemini_ignore: Type.Optional(Type.Boolean()),
	}, strict)),
}, strict);

export const geminiGlobParams = Type.Object({
	pattern: Type.String({ description: "Glob pattern to match" }),
	dir_path: Type.Optional(Type.String({ description: "Directory to search; defaults to cwd" })),
	case_sensitive: Type.Optional(Type.Boolean()),
	respect_git_ignore: Type.Optional(Type.Boolean()),
	respect_gemini_ignore: Type.Optional(Type.Boolean()),
}, strict);

export const searchFileContentParams = Type.Object({
	pattern: Type.String({ description: "Regex pattern to search for" }),
	dir_path: Type.Optional(Type.String({ description: "Directory to search; defaults to cwd" })),
	include: Type.Optional(Type.String({ description: "Glob pattern filter" })),
}, strict);

export const replaceParams = Type.Object({
	file_path: Type.String({ description: "Path to the file to modify" }),
	old_string: Type.String({ description: "Exact literal text to replace" }),
	new_string: Type.String({ description: "Exact replacement text" }),
	expected_replacements: Type.Optional(Type.Number({ minimum: 1, description: "Expected replacement count; defaults to 1" })),
}, strict);
