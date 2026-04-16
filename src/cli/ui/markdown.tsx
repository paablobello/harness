import { highlight, supportsLanguage } from "cli-highlight";
import { Box, Text } from "ink";
import { marked, type Tokens } from "marked";
import { Fragment, type ReactNode } from "react";

import { useTheme } from "./theme.js";

type MarkdownProps = {
  readonly text: string;
};

export function Markdown({ text }: MarkdownProps): ReactNode {
  const tokens = marked.lexer(text);
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => (
        <Fragment key={i}>{renderBlock(token, i)}</Fragment>
      ))}
    </Box>
  );
}

function renderBlock(token: Tokens.Generic, key: number): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "paragraph":
      return (
        <Box key={key}>
          <Text>{renderInline((token as Tokens.Paragraph).tokens ?? [])}</Text>
        </Box>
      );
    case "heading": {
      const h = token as Tokens.Heading;
      return (
        <Box key={key} marginTop={key === 0 ? 0 : 1}>
          <Text bold>
            {"#".repeat(h.depth)} {renderInline(h.tokens ?? [])}
          </Text>
        </Box>
      );
    }
    case "blockquote": {
      const bq = token as Tokens.Blockquote;
      return (
        <Box key={key} marginLeft={1}>
          <BlockquoteBar />
          <Box flexDirection="column" marginLeft={1}>
            {bq.tokens?.map((t, i) => (
              <Fragment key={i}>{renderBlock(t, i)}</Fragment>
            ))}
          </Box>
        </Box>
      );
    }
    case "code":
      return <CodeBlock key={key} token={token as Tokens.Code} />;
    case "list":
      return <ListBlock key={key} token={token as Tokens.List} />;
    case "hr":
      return (
        <Box key={key}>
          <Text dimColor>────────────</Text>
        </Box>
      );
    case "html":
    case "text":
      return (
        <Box key={key}>
          <Text>{(token as Tokens.Text).text ?? ""}</Text>
        </Box>
      );
    default:
      // Fall back to raw text to avoid swallowing content from unknown tokens.
      return (
        <Box key={key}>
          <Text>{token.raw ?? ""}</Text>
        </Box>
      );
  }
}

function renderInline(tokens: readonly Tokens.Generic[]): ReactNode {
  return tokens.map((t, i) => <Fragment key={i}>{renderInlineToken(t)}</Fragment>);
}

function renderInlineToken(token: Tokens.Generic): ReactNode {
  switch (token.type) {
    case "text": {
      const txt = token as Tokens.Text;
      if (txt.tokens && txt.tokens.length > 0) return renderInline(txt.tokens);
      return txt.text;
    }
    case "strong":
      return <Text bold>{renderInline((token as Tokens.Strong).tokens ?? [])}</Text>;
    case "em":
      return <Text italic>{renderInline((token as Tokens.Em).tokens ?? [])}</Text>;
    case "del":
      return <Text strikethrough>{renderInline((token as Tokens.Del).tokens ?? [])}</Text>;
    case "codespan":
      return <InlineCode text={(token as Tokens.Codespan).text} />;
    case "link": {
      const l = token as Tokens.Link;
      return (
        <LinkText href={l.href}>
          {renderInline(l.tokens ?? [{ type: "text", text: l.href, raw: l.href } as Tokens.Text])}
        </LinkText>
      );
    }
    case "br":
      return "\n";
    case "image":
      return (token as Tokens.Image).text ?? "";
    case "escape":
      return (token as Tokens.Escape).text ?? "";
    default:
      return (token as { raw?: string }).raw ?? "";
  }
}

function BlockquoteBar(): ReactNode {
  const theme = useTheme();
  return <Text color={theme.textMuted}>│</Text>;
}

function InlineCode({ text }: { text: string }): ReactNode {
  const theme = useTheme();
  return <Text color={theme.secondary}>`{text}`</Text>;
}

function LinkText({ href, children }: { href: string; children: ReactNode }): ReactNode {
  const theme = useTheme();
  return (
    <Text color={theme.primary}>
      {children} <Text dimColor>({href})</Text>
    </Text>
  );
}

function CodeBlock({ token }: { token: Tokens.Code }): ReactNode {
  const theme = useTheme();
  const lang = token.lang ?? "";
  const lines = (() => {
    if (lang && supportsLanguage(lang)) {
      try {
        return highlight(token.text, { language: lang, ignoreIllegals: true }).split("\n");
      } catch {
        return token.text.split("\n");
      }
    }
    return token.text.split("\n");
  })();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      borderDimColor
      paddingX={1}
      marginTop={1}
      marginBottom={1}
    >
      {lang && (
        <Box>
          <Text color={theme.textMuted}>{lang}</Text>
        </Box>
      )}
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>
  );
}

function ListBlock({ token }: { token: Tokens.List }): ReactNode {
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => (
        <Box key={i}>
          <Text>{token.ordered ? `${Number(token.start ?? 1) + i}. ` : "• "}</Text>
          <Box flexDirection="column">
            {item.tokens.map((t, j) => (
              <Fragment key={j}>{renderBlock(t, j)}</Fragment>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
}
