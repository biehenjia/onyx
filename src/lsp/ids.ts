/**
 * File extension -> LSP language identifier
 * (https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocumentItem).
 *
 * This is deliberately separate from `languageForExtension` in `../languages.ts`:
 * that one picks a CodeMirror grammar, this one picks the string a language
 * server expects in `textDocument/didOpen`. They mostly agree, but not always
 * (e.g. CM highlights `.h` with the C++ grammar; a server wants to decide C vs
 * C++ itself).
 */
export function languageIdForExtension(ext: string | undefined): string | null {
	switch ((ext ?? "").toLowerCase()) {
		case "py":
		case "pyi":
			return "python";
		case "c":
			return "c";
		case "h":
		case "hpp":
		case "hh":
		case "hxx":
		case "cc":
		case "cpp":
		case "cxx":
		case "c++":
			return "cpp";
		case "ts":
		case "mts":
		case "cts":
			return "typescript";
		case "tsx":
			return "typescriptreact";
		case "js":
		case "mjs":
		case "cjs":
			return "javascript";
		case "jsx":
			return "javascriptreact";
		case "rs":
			return "rust";
		case "go":
			return "go";
		case "json":
		case "jsonc":
			return "json";
		case "css":
			return "css";
		case "scss":
			return "scss";
		case "less":
			return "less";
		case "html":
		case "htm":
			return "html";
		case "yaml":
		case "yml":
			return "yaml";
		case "sql":
			return "sql";
		default:
			return null;
	}
}
