import { Extension } from "@codemirror/state";
import type { Language, LanguageSupport } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";

/**
 * Map a file extension to a CodeMirror language extension. Returns null for
 * extensions we register a view for but have no grammar bundled — those still
 * open and edit fine, just without highlighting.
 *
 * TODO: swap static imports for @codemirror/language-data + dynamic import once
 * the bundle grows uncomfortable (see NOTES.md #9).
 */
export function languageForExtension(ext: string | undefined): Extension | null {
	switch ((ext ?? "").toLowerCase()) {
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
			return javascript({ jsx: true });
		case "ts":
		case "mts":
		case "cts":
			return javascript({ typescript: true });
		case "tsx":
			return javascript({ jsx: true, typescript: true });
		case "py":
		case "pyi":
			return python();
		case "rs":
			return rust();
		case "go":
			return go();
		case "c":
		case "h":
		case "cc":
		case "cpp":
		case "cxx":
		case "hpp":
		case "hxx":
			return cpp();
		case "css":
		case "scss":
		case "less":
			return css();
		case "html":
		case "htm":
			return html();
		case "json":
		case "jsonc":
		case "json5":
			return json();
		case "yaml":
		case "yml":
			return yaml();
		case "sql":
			return sql();
		default:
			return null;
	}
}

/**
 * Fenced-block language tag (`typescript`, `py`, `c++`, …) -> a CodeMirror
 * `Language`, for highlighting code inside LSP hover / signature / completion
 * documentation. Passed to `LSPClient`'s `highlightLanguage`: lsp-client then
 * runs the block through `highlightCode` with the editor's active
 * `HighlightStyle`, so hover snippets pick up the same palette as the editor.
 *
 * Wider than `languageForExtension` on purpose — it takes the many names servers
 * use for a fence, not just our file extensions.
 */
const NAME_TO_SUPPORT: Record<string, () => LanguageSupport> = {
	typescript: () => javascript({ typescript: true }),
	ts: () => javascript({ typescript: true }),
	tsx: () => javascript({ typescript: true, jsx: true }),
	javascript: () => javascript(),
	js: () => javascript(),
	jsx: () => javascript({ jsx: true }),
	mjs: () => javascript(),
	cjs: () => javascript(),
	python: () => python(),
	py: () => python(),
	rust: () => rust(),
	rs: () => rust(),
	go: () => go(),
	golang: () => go(),
	c: () => cpp(),
	cpp: () => cpp(),
	"c++": () => cpp(),
	cc: () => cpp(),
	h: () => cpp(),
	hpp: () => cpp(),
	css: () => css(),
	scss: () => css(),
	less: () => css(),
	html: () => html(),
	htm: () => html(),
	xml: () => html(),
	json: () => json(),
	jsonc: () => json(),
	json5: () => json(),
	yaml: () => yaml(),
	yml: () => yaml(),
	sql: () => sql(),
};

const languageCache = new Map<string, Language | null>();

export function languageByName(name: string): Language | null {
	const key = (name || "").trim().toLowerCase();
	if (!key) return null;
	if (!languageCache.has(key)) {
		const make = NAME_TO_SUPPORT[key];
		languageCache.set(key, make ? make().language : null);
	}
	return languageCache.get(key) ?? null;
}
