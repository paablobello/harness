import { Text } from "ink";
import InkSpinner from "ink-spinner";
import type { ReactNode } from "react";

import { useTheme } from "../theme.js";

export function Spinner({ color }: { color?: string } = {}): ReactNode {
  const theme = useTheme();
  const c = color ?? theme.primary;
  return (
    <Text color={c}>
      <InkSpinner type="dots" />
    </Text>
  );
}
