import { accessSync, constants as fsConstants, statSync } from "fs";
import { delimiter, isAbsolute, join, resolve } from "path";

export interface SpawnSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type ServerResolution =
	| { ok: true; spec: SpawnSpec }
	| { ok: false; reason: string };

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveCommand(command: string, root: string): string | null {
	if (isAbsolute(command)) return isExecutableFile(command) ? command : null;
	if (command.includes("/") || command.includes("\\")) {
		const relative = resolve(root, command);
		return isExecutableFile(relative) ? relative : null;
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(directory, command);
		if (isExecutableFile(candidate)) return candidate;
	}
	return null;
}

/** Turn an approved onyx.toml argv into a child-process specification. */
export function resolveServer(
	realRoot: string,
	languageId: string,
	command: string[],
): ServerResolution {
	const [executable, ...args] = command;
	if (!executable) {
		return { ok: false, reason: `no command configured for ${languageId}` };
	}
	const resolved = resolveCommand(executable, realRoot);
	return resolved
		? { ok: true, spec: { command: resolved, args, cwd: realRoot, env: { ...process.env } } }
		: { ok: false, reason: `configured ${languageId} command "${executable}" was not found` };
}
