import { json, jsonParseLinter } from "@codemirror/lang-json";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { useMemo } from "react";

const sandboxTheme = EditorView.theme(
  {
    "&": { backgroundColor: "transparent", color: "oklch(0.9 0.005 286)" },
    ".cm-content": { padding: "12px 0", caretColor: "oklch(0.72 0.16 292)" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      color: "oklch(0.42 0.01 286)",
      border: "none",
      paddingLeft: "8px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "oklch(0.68 0.012 286)" },
    ".cm-activeLine": { backgroundColor: "oklch(0.21 0.004 286 / 0.6)" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "oklch(0.72 0.16 292 / 0.25) !important",
    },
    ".cm-cursor": { borderLeftColor: "oklch(0.72 0.16 292)" },
    ".cm-foldGutter .cm-gutterElement": { color: "oklch(0.42 0.01 286)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "oklch(0.27 0.006 286)",
      border: "none",
      color: "oklch(0.68 0.012 286)",
      padding: "0 6px",
      borderRadius: "4px",
    },
    ".cm-tooltip": {
      backgroundColor: "oklch(0.21 0.004 286)",
      border: "1px solid oklch(0.27 0.006 286)",
      borderRadius: "8px",
    },
    ".cm-diagnostic-error": { borderLeftColor: "oklch(0.68 0.2 25)" },
  },
  { dark: true },
);

const sandboxHighlight = HighlightStyle.define([
  { tag: tags.propertyName, color: "oklch(0.8 0.11 292)" },
  { tag: tags.string, color: "oklch(0.8 0.13 155)" },
  { tag: tags.number, color: "oklch(0.82 0.13 70)" },
  { tag: [tags.bool, tags.null], color: "oklch(0.75 0.14 240)" },
  { tag: tags.punctuation, color: "oklch(0.55 0.01 286)" },
  { tag: tags.brace, color: "oklch(0.55 0.01 286)" },
  { tag: tags.squareBracket, color: "oklch(0.55 0.01 286)" },
]);

interface JsonEditorProps {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  language?: "json" | "text";
}

export function JsonEditor({ value, onChange, readOnly = false, language = "json" }: JsonEditorProps) {
  const extensions = useMemo(() => {
    const base = [sandboxTheme, syntaxHighlighting(sandboxHighlight), EditorView.lineWrapping];
    if (language !== "json") return base;
    return readOnly ? [...base, json()] : [...base, json(), linter(jsonParseLinter(), { delay: 300 })];
  }, [language, readOnly]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      extensions={extensions}
      theme="none"
      height="100%"
      className="h-full"
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
        autocompletion: false,
        searchKeymap: true,
        bracketMatching: true,
        closeBrackets: !readOnly,
      }}
    />
  );
}
