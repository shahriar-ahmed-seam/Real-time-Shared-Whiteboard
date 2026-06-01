import { useState } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";

/** Test child that throws on demand so we can drive the boundary. */
function Bomb({ explode }: { explode: boolean }) {
  if (explode) {
    throw new Error("boom");
  }
  return <div>safe content</div>;
}

describe("ErrorBoundary", () => {
  // React logs caught render errors to the console; silence it for clean output.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children when no error occurs", () => {
    render(
      <ErrorBoundary>
        <Bomb explode={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText("safe content")).toBeInTheDocument();
  });

  it("shows a recoverable failure message with a retry control on error", () => {
    render(
      <ErrorBoundary>
        <Bomb explode={true} />
      </ErrorBoundary>
    );

    // Failure message is surfaced and announced to assistive tech.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    // Re-attempt control is present and keyboard-operable (a real button).
    expect(
      screen.getByRole("button", { name: /try again/i })
    ).toBeInTheDocument();
  });

  it("invokes onError when a render error is captured", () => {
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Bomb explode={true} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("re-attempts rendering and recovers when the retry control is used", () => {
    // A wrapper whose state flips the child from throwing to safe, simulating a
    // transient failure that succeeds on re-attempt.
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <ErrorBoundary onReset={() => setExplode(false)}>
          <Bomb explode={explode} />
        </ErrorBoundary>
      );
    }

    render(<Harness />);

    // Initially shows the fallback.
    expect(screen.getByRole("alert")).toBeInTheDocument();

    // Re-attempt rendering.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // Recovered: children render again, fallback is gone.
    expect(screen.getByText("safe content")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders a custom fallback when provided", () => {
    render(
      <ErrorBoundary
        fallback={({ error, reset }) => (
          <div>
            <span>custom: {error.message}</span>
            <button onClick={reset}>retry</button>
          </div>
        )}
      >
        <Bomb explode={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText("custom: boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
