import { accessSync, constants as fsConstants, statSync } from "fs";
import { delimiter as pathDelimiter, join } from "path";
import { homedir } from "os";

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Candidate invocations for a language id, tried in order. */
interface Candidate {
	/** Executable base name to look for. */
	bin: string;
	args: string[];
}

/**
 * Outcome of {@link resolveServer}: either a runnable spec, or a reason we found
 * nothing — so the caller (and, via the registry, the user) knows *why* a file
 * has no language server rather than just seeing silence.
 */
export type ServerResolution =
	| { ok: true; spec: SpawnSpec }
	| { ok: false; reason: string };

const CANDIDATES: Record<string, Candidate[]> = {
	python: [
		{ bin: "pyright-langserver", args: ["--stdio"] },
		{ bin: "basedpyright-langserver", args: ["--stdio"] },
		{ bin: "pylsp", args: [] },
		{ bin: "ruff", args: ["server"] },
	],
	cpp: [
		{ bin: "clangd", args: ["--background-index"] },
		{ bin: "ccls", args: [] },
	],
	c: [{ bin: "clangd", args: ["--background-index"] }],
	typescript: [{ bin: "typescript-language-server", args: ["--stdio"] }],
	typescriptreact: [{ bin: "typescript-language-server", args: ["--stdio"] }],
	javascript: [{ bin: "typescript-language-server", args: ["--stdio"] }],
	javascriptreact: [{ bin: "typescript-language-server", args: ["--stdio"] }],
	rust: [{ bin: "rust-analyzer", args: [] }],
	go: [{ bin: "gopls", args: [] }],
};

/** Root-relative dirs that hold project-local tool binaries, in priority order. */
const PROJECT_BIN_DIRS = [
	join(".venv", "bin"),
	join("node_modules", ".bin"),
	"bin",
];

/**
 * Absolute dirs to probe when a bare name isn't found project-locally and isn't
 * on the (often stunted, for a GUI app) inherited PATH. Deliberately covers the
 * common single-user install locations — Homebrew, pipx/pip --user, cargo, Nix
 * profiles — so we can find a server without spawning a dev shell.
 */
const EXTRA_BIN_DIRS = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	join(homedir(), ".local", "bin"),
	join(homedir(), ".cargo", "bin"),
	join(homedir(), ".nix-profile", "bin"),
	"/run/current-system/sw/bin",
	"/nix/var/nix/profiles/default/bin",
];

const EXE_SUFFIXES = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

function isExecutableFile(p: string): boolean {
	try {
		if (!statSync(p).isFile()) return false;
		accessSync(p, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Resolve `bin` to an absolute path, searching project dirs, PATH, then extras. */
function findBinary(bin: string, realRoot: string): string | null {
	const pathDirs = (process.env.PATH ?? "").split(pathDelimiter).filter(Boolean);
	const searchDirs = [
		...PROJECT_BIN_DIRS.map((d) => join(realRoot, d)),
		...pathDirs,
		...EXTRA_BIN_DIRS,
	];
	for (const dir of searchDirs) {
		for (const suffix of EXE_SUFFIXES) {
			const full = join(dir, bin + suffix);
			if (isExecutableFile(full)) return full;
		}
	}
	return null;
}

/**
 * Decide how to launch a language server for `languageId` rooted at `realRoot`.
 *
 * No dev-shell wrapping: we locate the server binary directly, preferring the
 * project's own `.venv/bin` and `node_modules/.bin`, and we prepend those to the
 * child's PATH so a server that shells out to sibling tools still finds them.
 *
 * `overrides` maps a language id to an explicit argv (from settings); if the
 * first element resolves to something runnable it wins over auto-detection.
 * On failure it returns `{ ok: false, reason }` — the caller skips LSP for that
 * file rather than spawning a doomed process, and surfaces the reason.
 */
export function resolveServer(
	realRoot: string,
	languageId: string,
	overrides: Record<string, string[]>,
): ServerResolution {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: [
			...PROJECT_BIN_DIRS.map((d) => join(realRoot, d)),
			process.env.PATH ?? "",
		]
			.filter(Boolean)
			.join(pathDelimiter),
	};

	const override = overrides[languageId];
	if (override && override.length > 0) {
		const [cmd, ...args] = override;
		const resolved = cmd.includes("/") ? cmd : findBinary(cmd, realRoot);
		if (resolved) return { ok: true, spec: { command: resolved, args, cwd: realRoot, env } };
		// An explicit override that doesn't resolve is a config error worth
		// surfacing, but not a reason to fall through to a different server.
		return {
			ok: false,
			reason: `configured ${languageId} language server "${cmd}" was not found`,
		};
	}

	const candidates = CANDIDATES[languageId] ?? [];
	if (candidates.length === 0) {
		return { ok: false, reason: `no known language server for ${languageId}` };
	}
	for (const cand of candidates) {
		const resolved = findBinary(cand.bin, realRoot);
		if (resolved) return { ok: true, spec: { command: resolved, args: cand.args, cwd: realRoot, env } };
	}
	const names = candidates.map((c) => c.bin).join(", ");
	return {
		ok: false,
		reason: `no ${languageId} language server found (looked for ${names} in .venv/bin, node_modules/.bin, PATH)`,
	};
}
