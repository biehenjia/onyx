import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";

const SCOPES: Record<string, ReadonlySet<string>> = {
	javascript: new Set([
		"NamespaceDeclaration", "ClassDeclaration", "FunctionDeclaration",
		"MethodDeclaration", "ArrowFunction",
	]),
	typescript: new Set([
		"NamespaceDeclaration", "ClassDeclaration", "InterfaceDeclaration",
		"FunctionDeclaration", "MethodDeclaration", "ArrowFunction",
	]),
	typescriptreact: new Set([
		"NamespaceDeclaration", "ClassDeclaration", "InterfaceDeclaration",
		"FunctionDeclaration", "MethodDeclaration", "ArrowFunction",
	]),
	javascriptreact: new Set([
		"NamespaceDeclaration", "ClassDeclaration", "FunctionDeclaration",
		"MethodDeclaration", "ArrowFunction",
	]),
	python: new Set(["ClassDefinition", "FunctionDefinition"]),
	rust: new Set(["ModItem", "TraitItem", "ImplItem", "FunctionItem"]),
	go: new Set(["FunctionDecl", "MethodDecl", "TypeDecl"]),
	c: new Set(["NamespaceDefinition", "ClassSpecifier", "StructSpecifier", "FunctionDefinition"]),
	cpp: new Set(["NamespaceDefinition", "ClassSpecifier", "StructSpecifier", "FunctionDefinition"]),
};

export interface StickyHeader {
	from: number;
	text: string;
}

function renderHighlightedLine(
	parent: HTMLElement,
	state: EditorState,
	header: StickyHeader,
): void {
	const tree = syntaxTree(state);
	const to = header.from + header.text.length;
	let cursor = header.from;
	highlightTree(
		tree,
		{
			style: (tags) => highlightingFor(state, tags, tree.type),
		},
		(from, tokenTo, classes) => {
			const clippedFrom = Math.max(from, header.from);
			const clippedTo = Math.min(tokenTo, to);
			if (clippedFrom >= clippedTo) return;
			if (clippedFrom > cursor) {
				parent.appendText(state.sliceDoc(cursor, clippedFrom));
			}
			parent.createSpan({
				cls: classes,
				text: state.sliceDoc(clippedFrom, clippedTo),
			});
			cursor = clippedTo;
		},
		header.from,
		to,
	);
	if (cursor < to) parent.appendText(state.sliceDoc(cursor, to));
}

/** Find declaration scopes containing the first visible line, outermost first. */
export function stickyHeaders(
	state: EditorState,
	visibleFrom: number,
	languageId: string | null,
): StickyHeader[] {
	const wanted = languageId ? SCOPES[languageId] : undefined;
	if (!wanted || state.doc.length === 0) return [];

	const visibleLine = state.doc.lineAt(Math.min(visibleFrom, state.doc.length));
	const firstCode = visibleLine.text.search(/\S/);
	const pos = firstCode < 0
		? visibleLine.from
		: visibleLine.from + firstCode;
	const found: SyntaxNode[] = [];
	for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
		if (wanted.has(node.name) && state.doc.lineAt(node.from).number < visibleLine.number) {
			found.push(node);
		}
	}

	const headers: StickyHeader[] = [];
	const seen = new Set<number>();
	for (const node of found.reverse()) {
		const line = state.doc.lineAt(node.from);
		if (seen.has(line.from)) continue;
		seen.add(line.from);
		headers.push({ from: line.from, text: line.text });
	}
	return headers;
}

class StickyScrollView {
	readonly dom: HTMLElement;
	private signature = "";
	private frame: number | null = null;
	private readonly onScroll = (): void => {
		if (this.frame !== null) return;
		this.frame = window.requestAnimationFrame(() => {
			this.frame = null;
			this.render();
		});
	};

	constructor(private view: EditorView, private languageId: string | null) {
		this.dom = this.view.dom.createDiv({ cls: "cm-sticky-scroll" });
		// The parsed viewport is buffered beyond what is visibly on screen, and
		// doesn't update for every line crossed while scrolling.
		this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
		this.render();
	}

	update(update: ViewUpdate): void {
		if (update.transactions.length > 0) this.signature = "";
		if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.length > 0) {
			this.render();
		}
	}

	destroy(): void {
		this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
		if (this.frame !== null) window.cancelAnimationFrame(this.frame);
		this.dom.remove();
	}

	private render(): void {
		const editorBox = this.view.dom.getBoundingClientRect();
		const contentBox = this.view.contentDOM.getBoundingClientRect();
		this.dom.style.paddingLeft = `${Math.max(0, contentBox.left - editorBox.left)}px`;
		const scrollBox = this.view.scrollDOM.getBoundingClientRect();
		const heightFromDocumentTop = Math.max(0, scrollBox.top - this.view.documentTop);
		const visibleFrom = this.view.lineBlockAtHeight(heightFromDocumentTop).from;
		const headers = stickyHeaders(this.view.state, visibleFrom, this.languageId);
		const signature = headers.map((header) => `${header.from}:${header.text}`).join("\0");
		if (signature === this.signature) return;
		this.signature = signature;
		this.dom.replaceChildren();
		this.dom.classList.toggle("is-active", headers.length > 0);

		for (const header of headers) {
			const row = this.dom.createEl("button", { cls: "cm-sticky-scroll-line" });
			row.type = "button";
			renderHighlightedLine(row, this.view.state, header);
			row.title = "Jump to scope";
			row.addEventListener("click", () => {
				this.view.dispatch({
					selection: { anchor: header.from },
					effects: EditorView.scrollIntoView(header.from, { y: "start" }),
				});
				this.view.focus();
			});
			this.dom.appendChild(row);
		}
	}
}

export function stickyScroll(languageId: string | null): Extension {
	return ViewPlugin.define((view) => new StickyScrollView(view, languageId));
}
