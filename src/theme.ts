import { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import type { OnyxSettings } from "./settings";

/**
 * Editor chrome. Everything here resolves to an `--onyx-*` custom property
 * defined in styles.css, which is in turn mapped onto Obsidian's colour-layer
 * primitives (`--color-*`, `--mono-rgb-*`, `--radius-*`, `--shadow-*`). No
 * hard-coded colours — the palette follows the active Obsidian theme.
 */
const chrome = EditorView.theme({
	"&": {
		color: "var(--text-normal)",
		backgroundColor: "transparent",
		height: "100%",
	},
	".cm-content": {
		caretColor: "var(--onyx-cursor)",
		padding: "var(--onyx-pad-block) 0",
	},
	".cm-line": {
		padding: "0 var(--onyx-pad-inline)",
	},
	// The indentation-marker extension assumes CodeMirror's stock line inset.
	// The extension centers its gradient half a character into the first
	// whitespace cell. Cancel that offset so guides mark the indentation
	// boundary itself.
	".cm-indent-markers::before": {
		left: "calc(var(--onyx-pad-inline) - 0.5ch)",
	},
	".cm-cursor, .cm-dropCursor": {
		borderLeftColor: "var(--onyx-cursor)",
		borderLeftWidth: "2px",
	},
	"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
		{
			backgroundColor: "var(--onyx-selection)",
		},
	".cm-selectionMatch": {
		backgroundColor: "var(--onyx-selection-match)",
		borderRadius: "2px",
	},
	".cm-gutters": {
		// Gutters are sticky and sit above the content. Keep them opaque so the
		// active-line background underneath cannot bleed into gutter columns.
		backgroundColor: "var(--background-primary)",
		color: "var(--onyx-gutter-fg)",
		border: "none",
	},
	".cm-lineNumbers .cm-gutterElement": {
		padding: "0 var(--onyx-gutter-pad)",
	},
	".cm-activeLine": {
		backgroundColor: "var(--onyx-active-line)",
	},
	// Match the editor's active-line wash across every gutter column, replacing
	// CodeMirror's bright built-in active-gutter block with one continuous row.
	"&.cm-light .cm-activeLineGutter, &.cm-dark .cm-activeLineGutter": {
		backgroundColor: "var(--onyx-active-line) !important",
		color: "var(--onyx-gutter-active-fg)",
	},
	".cm-foldGutter .cm-gutterElement": {
		opacity: "0",
		transition: "opacity 120ms ease",
	},
	"&:hover .cm-foldGutter .cm-gutterElement": {
		opacity: "1",
	},
	".cm-foldPlaceholder": {
		backgroundColor: "var(--onyx-bracket-match)",
		border: "none",
		color: "var(--text-muted)",
		margin: "0 4px",
		padding: "0 6px",
		borderRadius: "var(--radius-s)",
	},
	".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
		backgroundColor: "var(--onyx-bracket-match)",
		outline: "none",
		borderRadius: "2px",
	},
	".cm-nonmatchingBracket": {
		color: "var(--text-error)",
	},
	".cm-tooltip": {
		backgroundColor: "var(--onyx-panel-bg)",
		border: "1px solid var(--onyx-panel-border)",
		borderRadius: "var(--onyx-panel-radius)",
		boxShadow: "var(--onyx-panel-shadow)",
		color: "var(--text-normal)",
		overflow: "hidden",
	},
	".cm-tooltip.cm-tooltip-autocomplete > ul": {
		fontFamily: "inherit",
		maxHeight: "16em",
	},
	".cm-tooltip-autocomplete ul li[aria-selected]": {
		backgroundColor: "var(--background-modifier-hover)",
		color: "var(--text-normal)",
	},

	// --- language-server hover / signature tooltips ---------------------------
	".cm-tooltip.cm-tooltip-hover": {
		maxWidth: "min(46rem, 92vw)",
	},
	".cm-lsp-hover-tooltip": {
		maxHeight: "min(22rem, 60vh)",
		overflow: "auto",
		padding: "6px 10px",
		fontSize: "var(--font-smaller, 0.85em)",
		lineHeight: "1.5",
	},
	".cm-lsp-hover-tooltip > :first-child": { marginTop: "0" },
	".cm-lsp-hover-tooltip > :last-child": { marginBottom: "0" },
	".cm-lsp-signature-tooltip": {
		maxWidth: "min(46rem, 92vw)",
		maxHeight: "min(14rem, 45vh)",
	},
	".cm-lsp-signature": {
		fontFamily: "var(--onyx-font-family, var(--font-monospace))",
		fontSize: "var(--font-smaller, 0.85em)",
		lineHeight: "1.5",
		whiteSpace: "pre-wrap",
		padding: "6px 10px",
	},
	// The one parameter the cursor is currently on — the "at least the
	// parameters" highlight for signature help.
	".cm-lsp-active-parameter": {
		color: "var(--onyx-syntax-function)",
		fontWeight: "600",
	},
	".cm-lsp-signature-num": {
		color: "var(--text-faint)",
		fontSize: "0.8em",
		padding: "4px 10px 0",
	},
	".cm-lsp-signature-documentation": {
		borderTop: "1px solid var(--onyx-panel-border)",
		marginTop: "2px",
		padding: "6px 10px",
	},
	".cm-lsp-documentation p": { margin: "0.4em 0" },
	".cm-lsp-documentation pre": {
		margin: "0.45em 0",
		padding: "6px 8px",
		backgroundColor: "var(--onyx-bracket-match)",
		borderRadius: "var(--radius-s)",
		overflowX: "auto",
		whiteSpace: "pre",
	},
	".cm-lsp-documentation code": {
		fontFamily: "var(--onyx-font-family, var(--font-monospace))",
		fontSize: "0.92em",
	},
	".cm-lsp-documentation pre code": { fontSize: "1em" },
	".cm-lsp-documentation hr": {
		border: "none",
		borderTop: "1px solid var(--onyx-panel-border)",
		margin: "6px 0",
	},
	".cm-lsp-documentation a": { color: "var(--link-color)" },
	".cm-lsp-documentation h1, .cm-lsp-documentation h2, .cm-lsp-documentation h3, .cm-lsp-documentation h4, .cm-lsp-documentation h5, .cm-lsp-documentation h6":
		{
			fontSize: "1em",
			fontWeight: "600",
			margin: "0.5em 0 0.25em",
		},
	".cm-panels": {
		backgroundColor: "var(--onyx-panel-bg)",
		color: "var(--text-normal)",
		borderBottom: "1px solid var(--onyx-panel-border)",
	},
	".cm-panels .cm-textfield": {
		backgroundColor: "var(--background-primary)",
		border: "1px solid var(--background-modifier-border)",
		borderRadius: "var(--radius-s)",
		color: "var(--text-normal)",
	},
	".cm-panels .cm-button": {
		backgroundColor: "var(--interactive-normal)",
		backgroundImage: "none",
		border: "1px solid var(--background-modifier-border)",
		borderRadius: "var(--radius-s)",
		color: "var(--text-normal)",
	},
	".cm-searchMatch": {
		backgroundColor: "var(--onyx-selection-match)",
		borderRadius: "2px",
	},
	".cm-searchMatch.cm-searchMatch-selected": {
		backgroundColor: "var(--text-highlight-bg)",
	},
	".cm-scroller::-webkit-scrollbar": {
		width: "12px",
		height: "12px",
	},
	".cm-scroller::-webkit-scrollbar-thumb": {
		backgroundColor: "var(--background-modifier-border)",
		borderRadius: "8px",
		border: "3px solid transparent",
		backgroundClip: "content-box",
	},
	".cm-scroller::-webkit-scrollbar-thumb:hover": {
		backgroundColor: "var(--background-modifier-border-hover)",
	},
});

/**
 * Curated palette. Each Lezer tag group points at an `--onyx-syntax-*` token
 * (see styles.css) rather than a colour, so a snippet can retint any role and
 * light/dark tracks Obsidian automatically. Assignment is deliberately calm:
 * operators/punctuation stay muted, locals stay uncoloured, comments dim +
 * italic — the One / Zed register.
 */
const onyxHighlight = HighlightStyle.define([
	{
		tag: [t.comment, t.lineComment, t.blockComment],
		color: "var(--onyx-syntax-comment)",
		fontStyle: "italic",
	},
	{
		tag: [t.docComment, t.docString],
		color: "var(--onyx-syntax-doc)",
		fontStyle: "italic",
	},
	{
		tag: [
			t.keyword,
			t.modifier,
			t.controlKeyword,
			t.operatorKeyword,
			t.moduleKeyword,
			t.definitionKeyword,
		],
		color: "var(--onyx-syntax-keyword)",
	},
	{
		tag: [t.self, t.null, t.atom, t.bool, t.unit, t.constant(t.name)],
		color: "var(--onyx-syntax-constant)",
	},
	{
		tag: [t.number, t.integer, t.float],
		color: "var(--onyx-syntax-number)",
	},
	{
		tag: [t.string, t.special(t.string), t.attributeValue],
		color: "var(--onyx-syntax-string)",
	},
	{ tag: [t.regexp], color: "var(--onyx-syntax-regexp)" },
	{ tag: [t.escape], color: "var(--onyx-syntax-escape)" },
	{
		tag: [
			t.function(t.variableName),
			t.function(t.propertyName),
			t.macroName,
		],
		color: "var(--onyx-syntax-function)",
	},
	{
		tag: [
			t.typeName,
			t.className,
			t.namespace,
			t.definition(t.typeName),
		],
		color: "var(--onyx-syntax-type)",
	},
	{
		tag: [t.propertyName, t.definition(t.propertyName)],
		color: "var(--onyx-syntax-property)",
	},
	{ tag: [t.attributeName], color: "var(--onyx-syntax-attribute)" },
	{
		tag: [
			t.variableName,
			t.definition(t.variableName),
			t.local(t.variableName),
		],
		color: "var(--onyx-syntax-variable)",
	},
	{
		tag: [
			t.operator,
			t.derefOperator,
			t.compareOperator,
			t.arithmeticOperator,
			t.logicOperator,
			t.bitwiseOperator,
			t.updateOperator,
		],
		color: "var(--onyx-syntax-operator)",
	},
	{
		tag: [
			t.punctuation,
			t.separator,
			t.bracket,
			t.brace,
			t.paren,
			t.squareBracket,
			t.angleBracket,
		],
		color: "var(--onyx-syntax-punctuation)",
	},
	{
		tag: [t.tagName, t.standard(t.tagName)],
		color: "var(--onyx-syntax-tag)",
	},
	{
		tag: [t.meta, t.annotation, t.processingInstruction],
		color: "var(--onyx-syntax-meta)",
	},
	{ tag: [t.heading], color: "var(--onyx-syntax-heading)", fontWeight: "600" },
	{ tag: [t.strong], fontWeight: "600" },
	{ tag: [t.emphasis], fontStyle: "italic" },
	{ tag: [t.strikethrough], textDecoration: "line-through" },
	{
		tag: [t.link, t.url],
		color: "var(--onyx-syntax-link)",
		textDecoration: "underline",
	},
	{ tag: [t.invalid], color: "var(--onyx-syntax-invalid)" },
	{ tag: [t.changed], color: "var(--color-yellow)" },
	{ tag: [t.inserted], color: "var(--color-green)" },
	{ tag: [t.deleted], color: "var(--color-red)" },
]);

/** "Follow Obsidian theme" — reuse Obsidian's own code-block token variables. */
const obsidianHighlight = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--code-comment)", fontStyle: "italic" },
	{ tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.moduleKeyword], color: "var(--code-keyword)" },
	{ tag: [t.string, t.special(t.string), t.attributeValue], color: "var(--code-string)" },
	{ tag: [t.number, t.bool, t.null, t.atom], color: "var(--code-value)" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--code-function)" },
	{ tag: [t.propertyName, t.attributeName], color: "var(--code-property)" },
	{ tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--code-tag, var(--code-keyword))" },
	{ tag: [t.operator, t.punctuation, t.separator, t.bracket], color: "var(--text-muted)" },
	{ tag: [t.variableName, t.definition(t.variableName)], color: "var(--text-normal)" },
	{ tag: [t.invalid], color: "var(--text-error)" },
	{ tag: [t.link, t.url], color: "var(--link-color)", textDecoration: "underline" },
]);

/** The `HighlightStyle` currently in effect — reused to tokenise code inside
 *  LSP hover / signature docs so they match the editor. */
export function docHighlightStyle(settings: OnyxSettings): HighlightStyle {
	return settings.colorScheme === "onyx" ? onyxHighlight : obsidianHighlight;
}

/** Full style extension set for a `CodeView`, rebuilt on settings change. */
export function editorStyle(settings: OnyxSettings): Extension[] {
	const ext: Extension[] = [
		chrome,
		syntaxHighlighting(
			settings.colorScheme === "onyx" ? onyxHighlight : obsidianHighlight,
		),
	];

	if (settings.indentGuides) {
		ext.push(
			indentationMarkers({
				highlightActiveBlock: settings.activeIndentGuide,
				colors: {
					light: "var(--onyx-indent-guide)",
					dark: "var(--onyx-indent-guide)",
					activeLight: "var(--onyx-indent-guide-active)",
					activeDark: "var(--onyx-indent-guide-active)",
				},
			}),
		);
	}

	return ext;
}
