import type { Diagnostic } from "@codemirror/lint";
import { Annotation, type ChangeSet, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { TFile, View } from "obsidian";

/** Stable identity for the editor view, shared without importing the plugin root. */
export const VIEW_TYPE_CODE = "onyx-code-view";

/** Marks edits that originated outside the receiving editor view. */
export const mirroredEdit = Annotation.define<boolean>();

/** The small surface a document session needs from an attached editor. */
export interface SessionView {
	getEditorText(): string;
	setEditorText(text: string, resetHistory: boolean): void;
	applyMirroredChanges(changes: ChangeSet): void;
	applyMirroredDiagnostics(diagnostics: readonly Diagnostic[]): void;
	setLspExtension(extension: Extension): void;
	refreshDirtyIndicator(): void;
	save(): Promise<void>;
}

/** Editor capabilities used by LSP navigation. */
export interface NavigableCodeView extends View {
	file: TFile | null;
	readonly lspEditorView: EditorView | null;
}

export function isNavigableCodeView(view: View): view is NavigableCodeView {
	return view.getViewType() === VIEW_TYPE_CODE && "lspEditorView" in view;
}
