import { Component, type ErrorInfo, type ReactNode } from "react";
import { Text, View } from "react-native";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Pure-react-native crash guard for the Freebuff settings screen (owner
 * directive 2026-09-26: never white-screen). A missing host UI-kit primitive
 * on an older app build renders as undefined and React throws #130
 * ("Element type is invalid"); this boundary catches it (and any other
 * render error) and shows a readable message with the error text instead.
 * Deliberately imports nothing from @getpaseo/plugin/client — if that module
 * itself is the problem, the boundary still works.
 */
export class ScreenErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[freebuff] settings screen crashed:", error.message, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <View testID="freebuff-screen-error">
          <Text>Freebuff settings failed to render.</Text>
          <Text>{this.state.error.message}</Text>
          <Text>
            Update the Paseo app (or redeploy its web build) so it matches the installed Freebuff
            plugin, then reopen Settings.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}
