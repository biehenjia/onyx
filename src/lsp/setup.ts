import { existsSync, readFileSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { dirname, join, parse as parsePath } from "path";
import { pathToFileURL } from "url";
import { parse } from "smol-toml";

/**
 * Canonical identity shared by the editor, registry, workspace and launcher.
 * Keeping this as one value prevents a vault-side symlink path from leaking
 * into one half of the LSP setup while another half uses the real path.
 */
export interface LspSetup {
	key: string;
	name: string;
	configPath: string;
	fingerprint: string;
	realFile: string;
	realRoot: string;
	fileUri: string;
	rootUri: string;
	languageId: string;
	command: string[];
}

interface ProjectConfig {
	name?: unknown;
	lsp?: Record<string, { command?: unknown }>;
}

export function lspKey(realRoot: string, languageId: string): string {
	return `${realRoot}\0${languageId}`;
}

function commandFor(config: ProjectConfig, languageId: string): string[] | null {
	const value = config.lsp?.[languageId]?.command;
	return Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0)
		? value as string[]
		: null;
}

/** Find the nearest onyx.toml; its directory is the explicit project root. */
export function resolveLspSetup(absFile: string, languageId: string): LspSetup | null {
	let realFile: string;
	try {
		realFile = realpathSync(absFile);
	} catch {
		return null;
	}

	let dir = dirname(absFile);
	const filesystemRoot = parsePath(dir).root;
	for (;;) {
		const candidate = join(dir, "onyx.toml");
		if (existsSync(candidate)) {
			try {
				const configPath = realpathSync(candidate);
				const source = readFileSync(configPath, "utf8");
				const config = parse(source) as ProjectConfig;
				const command = commandFor(config, languageId);
				if (!command) return null;
				const realRoot = realpathSync(dirname(configPath));
				return {
					key: lspKey(realRoot, languageId),
					name: typeof config.name === "string" ? config.name : dirname(configPath).split(/[\\/]/).pop() ?? realRoot,
					configPath,
					fingerprint: createHash("sha256").update(source).digest("hex"),
					realFile,
					realRoot,
					fileUri: pathToFileURL(realFile).href,
					rootUri: pathToFileURL(realRoot).href,
					languageId,
					command,
				};
			} catch (error) {
				console.error(`Onyx: could not read ${candidate}`, error);
				return null;
			}
		}
		if (dir === filesystemRoot) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
