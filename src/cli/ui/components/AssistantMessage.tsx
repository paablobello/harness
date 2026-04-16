import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { Markdown } from "../markdown.js";
import type { AssistantMsg } from "../state.js";
import { useTheme } from "../theme.js";
import { Spinner } from "./Spinner.js";

type Props = {
  readonly msg: AssistantMsg;
  readonly adapter: string;
};

export function AssistantMessage({ msg, adapter }: Props): ReactNode {
  const theme = useTheme();
  const renderMarkdown = !msg.streaming && msg.text.length > 0;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.assistant} bold>
          {adapter}
        </Text>
        <Text color={theme.textMuted}>{" › "}</Text>
        {msg.streaming && (
          <>
            <Spinner color={theme.toolRunning} />
            <Text color={theme.textMuted}> streaming…</Text>
          </>
        )}
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {renderMarkdown ? <Markdown text={msg.text} /> : <StreamingText text={msg.text} />}
      </Box>
    </Box>
  );
}

function StreamingText({ text }: { text: string }): ReactNode {
  if (!text) return null;
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </>
  );
}
