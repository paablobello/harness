import { Box, Text, useInput } from "ink";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { SlashCommandContext } from "./commands.js";
import { Header } from "./components/Header.js";
import { InputPrompt } from "./components/InputPrompt.js";
import { MessageList } from "./components/MessageList.js";
import { Overlay } from "./components/Overlay.js";
import { PolicyDialog } from "./components/PolicyDialog.js";
import { StatusBar } from "./components/StatusBar.js";
import type { Action, SessionMeta, UiState } from "./state.js";
import { initialState, reducer } from "./state.js";
import { ThemeProvider } from "./theme.js";
import { resolveTheme } from "./themes/index.js";

export type AppCallbacks = {
  /** Called with the next user input; resolves the pending `input.next()` Promise. */
  readonly onUserMessage: (text: string) => void;
  /** Called when the user hits Esc to signal turn cancellation. */
  readonly onCancelTurn: () => void;
  /** Resolve a pending policy question. */
  readonly onPolicyResolve: (allow: boolean) => void;
};

export type AppProps = {
  readonly session: SessionMeta;
  readonly initialTheme: string;
  readonly history: readonly string[];
  readonly tools?: readonly { name: string; risk: string; source: string; description: string }[];
  readonly callbacks: AppCallbacks;
  readonly register: (dispatch: (action: Action) => void) => void;
};

export function App(props: AppProps): ReactNode {
  const [state, dispatch] = useReducer(reducer, initialState(props.session, props.initialTheme));
  const quitRef = useRef<number>(0);
  const exitSentRef = useRef(false);
  const [quitHint, setQuitHint] = useState(false);

  useEffect(() => {
    props.register(dispatch);
  }, [props.register]);

  useEffect(() => {
    if (state.shouldExit && !exitSentRef.current) {
      exitSentRef.current = true;
      // Signal EOF to the runtime; the bridge will unmount us after session ends.
      props.callbacks.onUserMessage("\x00__HARNESS_EXIT__\x00");
    }
  }, [state.shouldExit, props.callbacks]);

  const theme = useMemo(() => resolveTheme(state.themeName), [state.themeName]);

  const slashCtx = useMemo<SlashCommandContext>(
    () => ({
      dispatch,
      exit: () => dispatch({ type: "EXIT" }),
      currentTheme: state.themeName,
      details: state.details,
    }),
    [state.details, state.themeName],
  );

  const requestExit = useCallback((): void => {
    if (state.isTurnActive) props.callbacks.onCancelTurn();
    dispatch({ type: "EXIT" });
  }, [props.callbacks, state.isTurnActive]);

  // Close overlay with Esc (when nothing else is focused on Esc handling).
  useInput(
    (_input, key) => {
      if (key.escape && state.overlay) {
        dispatch({ type: "CLOSE_OVERLAY" });
      }
    },
    { isActive: state.overlay !== null && state.pendingPolicy === null },
  );

  // Ctrl+O toggles expand on the focused tool; Shift+Tab cycles focus.
  useInput(
    (_input, key) => {
      if (key.ctrl && _input === "o") {
        if (state.focusedToolId) dispatch({ type: "TOGGLE_EXPAND", id: state.focusedToolId });
      } else if (key.shift && key.tab) {
        dispatch({ type: "FOCUS_TOOL", direction: "next" });
      } else if (key.tab && !key.shift) {
        // No-op: Tab is reserved for slash completion inside InputPrompt.
      }
    },
    { isActive: state.pendingPolicy === null },
  );

  const handleQuit = (): void => {
    const now = Date.now();
    if (now - quitRef.current < 2000) {
      requestExit();
    } else {
      quitRef.current = now;
      setQuitHint(true);
      setTimeout(() => setQuitHint(false), 2000);
    }
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        props.callbacks.onCancelTurn();
        dispatch({ type: "INFO", level: "warn", text: "Cancelling current turn…" });
      } else if (key.ctrl && input === "c") {
        handleQuit();
      }
    },
    { isActive: state.isTurnActive && state.pendingPolicy === null },
  );

  return (
    <ThemeProvider value={theme}>
      <Box flexDirection="column">
        <Header session={state.session} />
        <MessageList
          messages={state.messages}
          adapterName={state.session.adapter.name}
          focusedToolId={state.focusedToolId}
          details={state.details}
        />
        {state.overlay && <Overlay overlay={state.overlay} state={state} tools={props.tools} />}
        {state.pendingPolicy && (
          <PolicyDialog
            request={state.pendingPolicy}
            onResolve={(allow) => {
              dispatch({ type: "POLICY_RESOLVE" });
              props.callbacks.onPolicyResolve(allow);
            }}
          />
        )}
        {!state.shouldExit && state.session.mode === "chat" && (
          <InputPrompt
            disabled={state.isTurnActive || state.pendingPolicy !== null}
            history={props.history}
            slashCtx={slashCtx}
            onSubmit={props.callbacks.onUserMessage}
            onCancel={props.callbacks.onCancelTurn}
            onQuitSignal={handleQuit}
            dispatch={dispatch}
          />
        )}
        <StatusBar state={state} />
        {quitHint && (
          <Box paddingX={1}>
            <Text color={theme.warning}>Press Ctrl+C again within 2s to exit.</Text>
          </Box>
        )}
      </Box>
    </ThemeProvider>
  );
}

// Exported for tests that want to drive the reducer directly.
export { initialState, reducer };

// Re-export for bridge convenience.
export type { UiState };
