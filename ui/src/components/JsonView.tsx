import { memo, useMemo } from "react";

type TokenKind = "key" | "string" | "number" | "literal" | "punct" | "plain";

interface Token {
  kind: TokenKind;
  text: string;
}

const TOKEN_CLASS: Record<TokenKind, string> = {
  key: "text-[oklch(0.8_0.11_292)]",
  string: "text-[oklch(0.8_0.13_155)]",
  number: "text-[oklch(0.82_0.13_70)]",
  literal: "text-[oklch(0.75_0.14_240)]",
  punct: "text-subtle",
  plain: "text-foreground",
};

const TOKEN_PATTERN = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

/** Splits one line of pretty-printed JSON into highlighted tokens. */
function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const index = match.index;
    if (index > cursor) tokens.push({ kind: "plain", text: line.slice(cursor, index) });

    const [whole, quoted, colon, number, literal, punct] = match;
    if (quoted !== undefined) {
      tokens.push({ kind: colon ? "key" : "string", text: quoted });
      if (colon) tokens.push({ kind: "punct", text: colon });
    } else if (number !== undefined) {
      tokens.push({ kind: "number", text: number });
    } else if (literal !== undefined) {
      tokens.push({ kind: "literal", text: literal });
    } else if (punct !== undefined) {
      tokens.push({ kind: "punct", text: punct });
    }
    cursor = index + whole.length;
  }

  if (cursor < line.length) tokens.push({ kind: "plain", text: line.slice(cursor) });
  return tokens;
}

interface JsonViewProps {
  value: string;
  /** Highlight as JSON; when false the text is shown verbatim. */
  json?: boolean;
}

/**
 * Lightweight read-only JSON viewer with line numbers and syntax highlighting.
 * It ships in the main bundle so payloads render instantly; the full
 * CodeMirror editor is only downloaded when the user starts editing.
 */
export const JsonView = memo(function JsonView({ value, json = true }: JsonViewProps) {
  const lines = useMemo(() => value.split("\n"), [value]);
  const gutterWidth = `${String(lines.length).length + 1}ch`;

  return (
    <pre className="min-w-0 py-3 font-mono text-[12.5px] leading-[1.65]">
      {lines.map((line, index) => (
        <div key={index} className="flex hover:bg-surface-raised/40">
          <span
            aria-hidden
            className="shrink-0 pr-4 pl-3 text-right text-[oklch(0.42_0.01_286)] select-none"
            style={{ width: `calc(${gutterWidth} + 1.75rem)` }}
          >
            {index + 1}
          </span>
          <code className="min-w-0 flex-1 pr-4 break-all whitespace-pre-wrap">
            {json
              ? tokenizeLine(line).map((token, tokenIndex) => (
                  <span key={tokenIndex} className={TOKEN_CLASS[token.kind]}>
                    {token.text}
                  </span>
                ))
              : line || " "}
          </code>
        </div>
      ))}
    </pre>
  );
});
