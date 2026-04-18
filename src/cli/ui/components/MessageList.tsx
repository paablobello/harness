import { Box } from "ink";
import type { ReactNode } from "react";

import type { Message } from "../state.js";
import { AssistantMessage } from "./AssistantMessage.js";
import { InfoLine } from "./InfoLine.js";
import { SensorLine } from "./SensorLine.js";
import { ToolBlock } from "./ToolBlock.js";
import { UserMessage } from "./UserMessage.js";

type Props = {
  readonly messages: readonly Message[];
  readonly adapterName: string;
  readonly focusedToolId: string | null;
  readonly details: boolean;
};

export function MessageList({ messages, adapterName, focusedToolId, details }: Props): ReactNode {
  return (
    <Box flexDirection="column">
      {messages.map((m, i) => {
        switch (m.kind) {
          case "user":
            return <UserMessage key={m.id} msg={m} />;
          case "assistant":
            return <AssistantMessage key={m.id} msg={m} adapter={adapterName} />;
          case "tool": {
            const next = messages[i + 1];
            const connector = next?.kind === "tool" && next.turn === m.turn;
            return (
              <ToolBlock
                key={m.id}
                msg={m}
                focused={focusedToolId === m.id}
                details={details}
                connector={connector}
              />
            );
          }
          case "sensor":
            return <SensorLine key={m.id} msg={m} />;
          case "info":
            return <InfoLine key={m.id} msg={m} />;
          default:
            return null;
        }
      })}
    </Box>
  );
}
