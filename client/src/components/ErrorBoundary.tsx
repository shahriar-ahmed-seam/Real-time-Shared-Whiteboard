import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Render-time fallback contract.
 *
 * A custom fallback receives the captured `error` and a `reset` callback that
 * clears the error state and re-attempts rendering of the wrapped subtree.
 */
export interface ErrorFallbackProps {
  error: Error;
  reset: () => void;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional custom fallback. Falls back to the built-in recovery panel. */
  fallback?: (props: ErrorFallbackProps) => ReactNode;
  /** Invoked when a render error is captured (for logging/observability). */
  onError?: (error: Error, info: ErrorInfo) => void;
  /** Invoked when the user re-attempts rendering. */
  onReset?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Reusable React error boundary.
 *
 * Catches rendering errors thrown anywhere in its child tree and, instead of
 * unmounting to a blank screen, renders a recoverable failure message with a
 * re-attempt control. The fallback UI is fully interactive (keyboard-operable
 * button), so the app remains responsive to user input after a failure.
 *
 * Requirement 4.2: a rendering error within the board view shows a failure
 * message with a control to re-attempt rendering and stays responsive.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the error for observability; React still reports it to the
    // console in dev, but this keeps a single intentional log site.
    console.error("ErrorBoundary caught a rendering error", error, info);
    this.props.onError?.(error, info);
  }

  private handleReset = (): void => {
    this.props.onReset?.();
    // Clearing the error re-renders children, re-attempting the failed render.
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;

    if (error) {
      if (this.props.fallback) {
        return this.props.fallback({ error, reset: this.handleReset });
      }
      return <DefaultErrorFallback error={error} reset={this.handleReset} />;
    }

    return this.props.children;
  }
}

/**
 * Built-in recovery panel. Token-driven styling only (no hardcoded literals);
 * announced to assistive tech via `role="alert"`.
 */
function DefaultErrorFallback({ error, reset }: ErrorFallbackProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex h-screen w-screen items-center justify-center bg-bg p-6"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-8 text-center shadow-md">
        <h1 className="mb-3 text-xl font-semibold text-text-strong">
          Something went wrong
        </h1>
        <p className="mb-2 text-sm leading-relaxed text-text">
          The board hit an unexpected error while rendering. Your connection is
          still active — you can re-attempt rendering without losing your place.
        </p>
        {error.message && (
          <p className="mb-6 break-words font-mono text-xs text-text-muted">
            {error.message}
          </p>
        )}
        <button
          type="button"
          onClick={reset}
          className="w-full rounded-md bg-primary px-4 py-3 text-sm font-semibold text-text-on-primary transition-colors hover:bg-primary-hover"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

export default ErrorBoundary;
