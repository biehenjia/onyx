import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { GutterMarker, gutter } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";

export type DiffLineKind = "added" | "modified" | "deleted";
export interface DiffLine { line: number; kind: DiffLineKind }

export function diffLines(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (before.endsWith("\n")) a.pop();
	if (after.endsWith("\n")) b.pop();
	const cells = (a.length + 1) * (b.length + 1);
	if (cells > 4_000_000) {
		let start = 0;
		while (start < a.length && start < b.length && a[start] === b[start]) start++;
		let ae = a.length - 1, be = b.length - 1;
		while (ae >= start && be >= start && a[ae] === b[be]) { ae--; be--; }
		return Array.from({ length: Math.max(1, be - start + 1) }, (_, i) => ({ line: Math.min(b.length || 1, start + i + 1), kind: "modified" as const }));
	}
	const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
		dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const removed: number[] = [], added: number[] = [];
	let i = 0, j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
		else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) { added.push(j + 1); j++; }
		else { removed.push(Math.max(1, j + 1)); i++; }
	}
	const removedSet = new Set(removed), addedSet = new Set(added);
	const modifiedSet = new Set<number>();
	for (const line of added) {
		const paired = removedSet.has(line) ? line : removedSet.has(line + 1) ? line + 1 : null;
		if (paired !== null) {
			addedSet.delete(line);
			removedSet.delete(paired);
			modifiedSet.add(line);
		}
	}
	const lines = new Set([...removedSet, ...addedSet, ...modifiedSet]);
	return [...lines].sort((x, y) => x - y).map((line) => ({
		line: Math.min(Math.max(1, line), Math.max(1, b.length)),
		kind: modifiedSet.has(line) ? "modified" : addedSet.has(line) ? "added" : "deleted",
	}));
}

class GitMarker extends GutterMarker {
	constructor(readonly kind: DiffLineKind) { super(); }
	toDOM(): HTMLElement {
		return createSpan({ cls: `onyx-git-marker mod-${this.kind}` });
	}
}

export const setGitBaseline = StateEffect.define<string | null>();

export function gitGutter(): Extension {
	const field = StateField.define<{ baseline: string | null; markers: RangeSet<GutterMarker> }>({
		create: () => ({ baseline: null, markers: RangeSet.of<GutterMarker>([]) }),
		update(value, tr) {
			let baseline = value.baseline;
			for (const effect of tr.effects) if (effect.is(setGitBaseline)) baseline = effect.value;
			if (baseline === value.baseline && !tr.docChanged) return value;
			if (baseline === null) return { baseline, markers: RangeSet.of<GutterMarker>([]) };
			const ranges = diffLines(baseline, tr.state.doc.toString()).map(({ line, kind }) =>
				new GitMarker(kind).range(tr.state.doc.line(Math.min(line, tr.state.doc.lines)).from));
			return { baseline, markers: RangeSet.of(ranges, true) };
		},
	});
	return [field, gutter({ class: "onyx-git-gutter", markers: (view) => view.state.field(field).markers })];
}
