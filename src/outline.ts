import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

export type OutlineKind = "namespace" | "class" | "interface" | "function";

export interface OutlineEntry {
	name: string;
	kind: OutlineKind;
	/** Beginning of the declaration, suitable for navigation. */
	from: number;
	/** End of the declaration body, used for nesting and scope lookup. */
	to: number;
	children: OutlineEntry[];
}

/** A flat declaration shape retained for function-specific callers. */
export interface FunctionDeclaration {
	name: string;
	from: number;
	to: number;
}

const SCOPE_NODES: Record<string, ReadonlyMap<string, OutlineKind>> = {
	javascript: new Map([
		["ClassDeclaration", "class"], ["FunctionDeclaration", "function"],
		["MethodDeclaration", "function"], ["ArrowFunction", "function"],
	]),
	typescript: new Map([
		["NamespaceDeclaration", "namespace"], ["ClassDeclaration", "class"],
		["InterfaceDeclaration", "interface"], ["FunctionDeclaration", "function"],
		["MethodDeclaration", "function"], ["ArrowFunction", "function"],
	]),
	typescriptreact: new Map([
		["NamespaceDeclaration", "namespace"], ["ClassDeclaration", "class"],
		["InterfaceDeclaration", "interface"], ["FunctionDeclaration", "function"],
		["MethodDeclaration", "function"], ["ArrowFunction", "function"],
	]),
	javascriptreact: new Map([
		["ClassDeclaration", "class"], ["FunctionDeclaration", "function"],
		["MethodDeclaration", "function"], ["ArrowFunction", "function"],
	]),
	python: new Map([["ClassDefinition", "class"], ["FunctionDefinition", "function"]]),
	rust: new Map([
		["ModItem", "namespace"], ["TraitItem", "interface"], ["ImplItem", "class"],
		["StructItem", "class"], ["EnumItem", "class"], ["FunctionItem", "function"],
	]),
	go: new Map([["FunctionDecl", "function"], ["MethodDecl", "function"]]),
	c: new Map([["NamespaceDefinition", "namespace"], ["StructSpecifier", "class"], ["FunctionDefinition", "function"]]),
	cpp: new Map([
		["NamespaceDefinition", "namespace"], ["ClassSpecifier", "class"],
		["StructSpecifier", "class"], ["FunctionDefinition", "function"],
	]),
};

function declarationStart(node: SyntaxNode): number {
	if (node.name !== "ArrowFunction") return node.from;
	for (let parent = node.parent; parent; parent = parent.parent) {
		if (parent.name === "VariableDeclaration" || parent.name === "VariableDefinition") return parent.from;
		if (parent.name === "FunctionDeclaration" || parent.name === "MethodDeclaration") break;
	}
	return node.from;
}

function functionName(text: string): string | null {
	const keyword = /\b(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)/.exec(text);
	if (keyword) return keyword[1];
	const arrow = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.exec(text);
	if (arrow) return arrow[1];
	const body = text.search(/\{/);
	const header = text.slice(0, body < 0 ? text.length : body);
	const calls = [...header.matchAll(/([A-Za-z_$][\w$]*)\s*(?:<[^>{}()]*>)?\s*\(/g)];
	return calls.length > 0 ? calls[calls.length - 1][1] : null;
}

function scopeName(text: string, kind: OutlineKind): string | null {
	if (kind === "function") return functionName(text);
	const keyword = kind === "namespace"
		? /\b(?:namespace|module|mod)\s+([A-Za-z_$][\w$]*)/.exec(text)
		: /\b(?:class|struct|trait|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(text);
	if (keyword) return keyword[1];
	if (kind === "class") {
		const implementation = /\bimpl\s+(?:[\w$]+\s+for\s+)?([A-Za-z_$][\w$]*)/.exec(text);
		if (implementation) return `impl ${implementation[1]}`;
	}
	return null;
}

function declarationForNode(
	state: EditorState,
	node: SyntaxNode,
	kind: OutlineKind,
): OutlineEntry | null {
	const from = declarationStart(node);
	const text = state.sliceDoc(from, Math.min(node.to, from + 800));
	const name = scopeName(text, kind);
	return name ? { name, kind, from, to: node.to, children: [] } : null;
}

function uniqueInSourceOrder(entries: OutlineEntry[]): OutlineEntry[] {
	entries.sort((a, b) => a.from - b.from || b.to - a.to);
	return entries.filter((entry, index) =>
		index === 0 || entry.from !== entries[index - 1].from || entry.to !== entries[index - 1].to,
	);
}

function nest(entries: OutlineEntry[]): OutlineEntry[] {
	const roots: OutlineEntry[] = [];
	const stack: OutlineEntry[] = [];
	for (const entry of uniqueInSourceOrder(entries)) {
		while (stack.length > 0) {
			const parent = stack[stack.length - 1];
			if (parent.from <= entry.from && entry.to <= parent.to) break;
			stack.pop();
		}
		const parent = stack[stack.length - 1];
		(parent ? parent.children : roots).push(entry);
		stack.push(entry);
	}
	return roots;
}

/** A small text fallback for file types without a bundled CodeMirror grammar. */
export function fallbackFunctionDeclarations(text: string): FunctionDeclaration[] {
	const declarations: FunctionDeclaration[] = [];
	const pattern = /^\s*(?:(?:export|default|public|private|protected|static|async)\s+)*(?:function|def|fn|func)\s+([A-Za-z_$][\w$]*)/gm;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const name = match[1];
		const from = match.index + match[0].lastIndexOf(name);
		const to = text.indexOf("\n", from);
		declarations.push({ name, from, to: to < 0 ? text.length : to });
	}
	return declarations;
}

/** All class, namespace, interface, and function scopes as a source-ordered tree. */
export function outlineEntries(state: EditorState, languageId: string | null): OutlineEntry[] {
	const wanted = languageId ? SCOPE_NODES[languageId] : undefined;
	if (!wanted || state.doc.length === 0) {
		return fallbackFunctionDeclarations(state.doc.toString())
			.map((entry) => ({ ...entry, kind: "function" as const, children: [] }));
	}
	const entries: OutlineEntry[] = [];
	syntaxTree(state).iterate({
		enter: (node) => {
			const kind = wanted.get(node.name);
			if (!kind) return;
			const entry = declarationForNode(state, node.node, kind);
			if (entry) entries.push(entry);
		},
	});
	return entries.length > 0
		? nest(entries)
		: fallbackFunctionDeclarations(state.doc.toString())
			.map((entry) => ({ ...entry, kind: "function" as const, children: [] }));
}

function flatten(entries: OutlineEntry[]): OutlineEntry[] {
	return entries.flatMap((entry) => [entry, ...flatten(entry.children)]);
}

/** Function and method declarations in source order. */
export function functionDeclarations(state: EditorState, languageId: string | null): FunctionDeclaration[] {
	return flatten(outlineEntries(state, languageId))
		.filter((entry) => entry.kind === "function")
		.map(({ name, from, to }) => ({ name, from, to }));
}

/** The complete outermost-to-innermost scope chain for a document position. */
export function scopeChain(state: EditorState, position: number, languageId: string | null): OutlineEntry[] {
	const bounded = Math.max(0, Math.min(position, state.doc.length));
	return flatten(outlineEntries(state, languageId))
		.filter((entry) => entry.from <= bounded && bounded <= entry.to)
		.sort((a, b) => a.from - b.from || b.to - a.to);
}

/** The innermost selected function, if the selection is inside one. */
export function currentFunction(state: EditorState, position: number, languageId: string | null): FunctionDeclaration | null {
	const functions = scopeChain(state, position, languageId)
		.filter((entry) => entry.kind === "function");
	const entry = functions[functions.length - 1];
	return entry ? { name: entry.name, from: entry.from, to: entry.to } : null;
}
