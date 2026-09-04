import { execFile, type ChildProcess } from "child_process";

export interface LintIssue {
	line: number;
	column: number;
	endLine?: number;
	endColumn?: number;
	severity: "error" | "warning" | "info";
	message: string;
	source?: string;
}

function severity(value: unknown): LintIssue["severity"] {
	if (value === 2 || value === "error") return "error";
	if (value === 1 || value === "warning" || value === "warn") return "warning";
	return "info";
}

/** Accept ESLint JSON (and similarly-shaped tools), falling back to GCC/errfmt lines. */
export function parseLintOutput(output: string): LintIssue[] {
	try {
		const parsed = JSON.parse(output) as unknown;
		const records = Array.isArray(parsed) ? parsed : [parsed];
		const issues: LintIssue[] = [];
		for (const record of records) {
			if (!record || typeof record !== "object") continue;
			const holder = record as Record<string, unknown>;
			const messages = Array.isArray(holder.messages) ? holder.messages : [holder];
			for (const raw of messages) {
				if (!raw || typeof raw !== "object") continue;
				const item = raw as Record<string, unknown>;
				if (typeof item.message !== "string") continue;
				issues.push({
					line: Math.max(1, Number(item.line) || 1),
					column: Math.max(1, Number(item.column) || 1),
					endLine: Number(item.endLine) || undefined,
					endColumn: Number(item.endColumn) || undefined,
					severity: severity(item.severity),
					message: item.message,
					source: typeof item.ruleId === "string" ? item.ruleId : undefined,
				});
			}
		}
		if (issues.length > 0 || output.trim() === "[]") return issues;
	} catch {
		// Try line-oriented output below.
	}

	const issues: LintIssue[] = [];
	for (const line of output.split(/\r?\n/)) {
		const match = /^(?:.*?):(\d+):(\d+):\s*(?:(error|warning|warn|info)\s*:?\s*)?(.*)$/i.exec(line);
		if (!match || !match[4]) continue;
		issues.push({
			line: Number(match[1]),
			column: Number(match[2]),
			severity: severity(match[3]?.toLowerCase()),
			message: match[4],
		});
	}
	return issues;
}

export function startLint(
	command: readonly string[],
	file: string,
	workspace: string,
	onDone: (error: Error | null, issues: LintIssue[]) => void,
): ChildProcess | null {
	const [executable, ...configuredArgs] = command;
	if (!executable) return null;
	const args = configuredArgs.map((arg) => arg
		.replaceAll("${file}", file)
		.replaceAll("${workspace}", workspace));
	const child = execFile(executable, args, {
		cwd: workspace,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}, (error, stdout, stderr) => {
		// Linters conventionally use a non-zero exit for findings. Only treat a
		// launch failure (no numeric exit code) as an execution error.
		const launchError = error && typeof error.code !== "number" ? error : null;
		onDone(launchError, parseLintOutput(`${stdout}\n${stderr}`));
	});
	return child;
}
