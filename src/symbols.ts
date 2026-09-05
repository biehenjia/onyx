import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { EditorView } from "@codemirror/view";
import { LSPPlugin } from "@codemirror/lsp-client";
import type {
	DocumentSymbol,
	Position,
	SymbolInformation,
} from "vscode-languageserver-protocol";
import { outlineEntries, type OutlineEntry } from "./outline";

export const SYMBOLS_VIEW = "onyx-symbols";

export interface SymbolTarget {
	editor: EditorView;
	fileName: string;
	languageId: string | null;
}

export interface SymbolEntry {
	name: string;
	detail?: string;
	kind: number;
	from: number;
	to: number;
	children: SymbolEntry[];
}

export interface SymbolsDeps {
	getTarget(): SymbolTarget | null;
}

function offsetAt(editor: EditorView, position: Position): number {
	const lineNumber = Math.min(position.line + 1, editor.state.doc.lines);
	const line = editor.state.doc.line(lineNumber);
	return Math.min(line.from + position.character, line.to);
}

function isDocumentSymbol(
	symbol: DocumentSymbol | SymbolInformation,
): symbol is DocumentSymbol {
	return "selectionRange" in symbol;
}

function fromLsp(
	editor: EditorView,
	symbol: DocumentSymbol | SymbolInformation,
): SymbolEntry {
	const selectionRange = isDocumentSymbol(symbol)
		? symbol.selectionRange
		: symbol.location.range;
	const scopeRange = isDocumentSymbol(symbol) ? symbol.range : symbol.location.range;
	return {
		name: symbol.name,
		detail: isDocumentSymbol(symbol) ? symbol.detail : symbol.containerName,
		kind: symbol.kind,
		from: offsetAt(editor, selectionRange.start),
		to: offsetAt(editor, scopeRange.end),
		children: isDocumentSymbol(symbol)
			? (symbol.children ?? []).map((child) => fromLsp(editor, child))
			: [],
	};
}

/** Lightweight outline while no language server is available. */
export function fallbackSymbols(text: string): SymbolEntry[] {
	const symbols: SymbolEntry[] = [];
	const pattern = /^\s*(?:(?:export|default|public|private|protected|static|async)\s+)*(class|interface|enum|type|function|def|fn|func|struct|trait)\s+([A-Za-z_$][\w$]*)/;
	let offset = 0;
	for (const line of text.split("\n")) {
		const match = pattern.exec(line);
		if (match) {
			const kind = ["class", "struct", "trait"].includes(match[1])
				? 5
				: match[1] === "interface"
					? 11
					: match[1] === "enum"
						? 10
						: match[1] === "type"
							? 13
							: 12;
			symbols.push({
				name: match[2],
			kind,
			from: offset + (match.index ?? 0) + line.indexOf(match[2]),
			to: offset + line.length,
			children: [],
			});
		}
		offset += line.length + 1;
	}
	return symbols;
}

function outlineKind(kind: number): OutlineEntry["kind"] | null {
	// LSP SymbolKind: Module/Namespace/Package, Class/Struct/Enum, Interface,
	// and Method/Constructor/Function respectively.
	if (kind === 2 || kind === 3 || kind === 4) return "namespace";
	if (kind === 5 || kind === 10 || kind === 23) return "class";
	if (kind === 11) return "interface";
	if (kind === 6 || kind === 9 || kind === 12) return "function";
	return null;
}

function outlinesFromSymbols(entries: SymbolEntry[]): OutlineEntry[] {
	const visit = (items: SymbolEntry[]): OutlineEntry[] => items.flatMap((entry) => {
		const children = visit(entry.children);
		const kind = outlineKind(entry.kind);
		return kind ? [{
			name: entry.name,
			kind,
			from: entry.from,
			to: entry.to,
			children,
		}] : children;
	});
	return visit(entries).sort((a, b) => a.from - b.from || a.to - b.to);
}

export class SymbolsPane extends ItemView {
	private bodyEl: HTMLElement | null = null;
	private requestId = 0;

	constructor(leaf: WorkspaceLeaf, private readonly deps: SymbolsDeps) {
		super(leaf);
	}

	getViewType(): string { return SYMBOLS_VIEW; }
	getIcon(): string { return "list-ordered"; }
	getDisplayText(): string { return "Outline"; }

	async onOpen(): Promise<void> {
		this.contentEl.addClass("onyx-symbols-content");
		this.addAction("refresh-cw", "Refresh outline", () => void this.refresh());
		this.bodyEl = this.contentEl.createDiv({ cls: "onyx-symbols-list" });
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const requestId = ++this.requestId;
		const target = this.deps.getTarget();
		if (!this.bodyEl) return;
		if (!target) {
			this.render([], "Open a source file to see its functions.", null);
			return;
		}

		let entries = outlineEntries(target.editor.state, target.languageId);
		const plugin = LSPPlugin.get(target.editor);
		// The local syntax tree is immediate and includes unsaved text. Use the
		// server only as a fallback for languages without a bundled grammar.
		if (entries.length === 0 && plugin?.client.connected) {
			try {
				plugin.client.sync();
				const result = await plugin.client.request<
					{ textDocument: { uri: string } },
					DocumentSymbol[] | SymbolInformation[] | null
				>("textDocument/documentSymbol", {
					textDocument: { uri: plugin.uri },
				});
				entries = outlinesFromSymbols(
					result?.map((symbol) => fromLsp(target.editor, symbol)) ?? [],
				);
			} catch {
				// A server may be connected without document-symbol support.
			}
		}

		if (requestId !== this.requestId) return;
		this.render(entries, target.fileName, target.editor);
	}

	private render(
		entries: OutlineEntry[],
		label: string,
		editor: EditorView | null,
	): void {
		if (!this.bodyEl) return;
		this.bodyEl.empty();
		this.bodyEl.createDiv({ cls: "onyx-symbols-file", text: label });
		if (entries.length === 0) {
			this.bodyEl.createDiv({ cls: "onyx-symbols-empty", text: "No declarations found." });
			return;
		}
		this.renderEntries(this.bodyEl, entries, editor);
	}

	private renderEntries(
		parent: HTMLElement,
		entries: OutlineEntry[],
		editor: EditorView | null,
	): void {
		for (const entry of entries) {
			const item = parent.createDiv({ cls: "tree-item onyx-symbol-item" });
			const row = item.createDiv({ cls: "tree-item-self is-clickable" });
			const icon = row.createDiv({ cls: "tree-item-icon" });
			setIcon(icon, entry.kind === "function" ? "function-square" : entry.kind === "namespace" ? "braces" : "box");
			row.createDiv({ cls: "tree-item-inner", text: entry.name });
			row.addEventListener("click", () => {
				if (!editor) return;
				editor.dispatch({
					selection: { anchor: entry.from },
					effects: EditorView.scrollIntoView(entry.from, { y: "center" }),
				});
				editor.focus();
			});
			if (entry.children.length > 0) {
				const children = item.createDiv({ cls: "tree-item-children" });
				this.renderEntries(children, entry.children, editor);
			}
		}
	}
}
