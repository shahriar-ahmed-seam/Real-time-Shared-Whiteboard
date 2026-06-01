import { useState } from "react";
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  Button,
  Input,
  Modal,
  Tooltip,
  Toolbar,
  ToolbarButton,
} from "../../src/components/ui";

/**
 * Accessibility unit tests for the `ui/` component library (Task 11.6).
 *
 * Covers keyboard operability, focus management (modal trap + restore), and the
 * presence of ARIA labels / text alternatives, validating the design's
 * accessibility acceptance criteria:
 *   - Requirement 10.3 (full keyboard operability, no keyboard trap)
 *   - Requirement 10.6 (focus management / visible focus target)
 *   - Requirement 10.7 (programmatic text alternatives for controls)
 *
 * jsdom performs no layout, so `HTMLElement.offsetParent` is always null. The
 * components' focusable-element discovery (`getFocusableElements`) filters on
 * `offsetParent`, so we polyfill it to mirror real-browser visibility. This is
 * the standard approach for exercising focus-trap logic under jsdom.
 */
const originalOffsetParent = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetParent",
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      // Attached, rendered elements have a parent; detached ones report null.
      return this.parentNode;
    },
  });
});

afterAll(() => {
  if (originalOffsetParent) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetParent",
      originalOffsetParent,
    );
  }
});

describe("Button accessibility", () => {
  it("exposes the aria-label as the accessible name for icon-only buttons", () => {
    render(
      <Button variant="icon" aria-label="Zoom in">
        <svg aria-hidden="true" />
      </Button>,
    );

    // Text alternative for a non-text control (Requirement 10.7).
    const button = screen.getByRole("button", { name: "Zoom in" });
    expect(button).toHaveAttribute("aria-label", "Zoom in");
  });

  it("derives the accessible name from text content for labelled buttons", () => {
    render(<Button>Create board</Button>);
    expect(
      screen.getByRole("button", { name: "Create board" }),
    ).toBeInTheDocument();
  });

  it("is operable with the keyboard via Enter and Space", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button variant="icon" aria-label="Clear canvas" onClick={onClick}>
        <svg aria-hidden="true" />
      </Button>,
    );

    // Tab moves focus to the button (Requirement 10.3).
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear canvas" })).toHaveFocus();

    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("Input accessibility", () => {
  it("programmatically associates the visible label with the field", () => {
    render(<Input label="Your name" />);

    // getByLabelText only resolves when label/control are wired (Req 10.7).
    const input = screen.getByLabelText("Your name");
    expect(input).toBe(screen.getByRole("textbox"));
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the label association when visually hidden", () => {
    render(<Input label="Search" hideLabel />);
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
  });

  it("sets aria-invalid and wires aria-describedby to the error message", () => {
    render(<Input label="Room code" error="Code is required" />);

    const input = screen.getByLabelText("Room code");
    expect(input).toHaveAttribute("aria-invalid", "true");
    // The error text is exposed as the field's accessible description.
    expect(input).toHaveAccessibleDescription("Code is required");
  });
});

describe("Tooltip accessibility", () => {
  it("is hidden until the trigger is focused, then wires aria-describedby", async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Delete board">
        <button>Delete</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Delete" });
    // Hidden tooltips are excluded from the accessibility tree.
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");

    // Appears on keyboard focus, not only hover (Requirement 10.3 / 10.7).
    await user.tab();
    expect(trigger).toHaveFocus();

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveTextContent("Delete board");
    expect(trigger).toHaveAttribute("aria-describedby", tooltip.id);

    // Dismissed on blur so it no longer describes the control.
    await user.tab();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(trigger).not.toHaveAttribute("aria-describedby");
  });
});

describe("Toolbar accessibility", () => {
  function ToolbarFixture() {
    return (
      <Toolbar aria-label="Drawing tools">
        <ToolbarButton aria-label="Pen">P</ToolbarButton>
        <ToolbarButton aria-label="Eraser">E</ToolbarButton>
        <ToolbarButton aria-label="Clear">C</ToolbarButton>
      </Toolbar>
    );
  }

  it("exposes an accessible toolbar name and per-button text alternatives", () => {
    render(<ToolbarFixture />);

    expect(
      screen.getByRole("toolbar", { name: "Drawing tools" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Eraser" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("implements a roving tabindex with a single tab stop", () => {
    render(<ToolbarFixture />);

    const pen = screen.getByRole("button", { name: "Pen" });
    const eraser = screen.getByRole("button", { name: "Eraser" });
    const clear = screen.getByRole("button", { name: "Clear" });

    // Only the first button is in the tab order initially.
    expect(pen).toHaveAttribute("tabindex", "0");
    expect(eraser).toHaveAttribute("tabindex", "-1");
    expect(clear).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with arrow keys and wraps at the ends (Req 10.3)", async () => {
    const user = userEvent.setup();
    render(<ToolbarFixture />);

    const pen = screen.getByRole("button", { name: "Pen" });
    const eraser = screen.getByRole("button", { name: "Eraser" });
    const clear = screen.getByRole("button", { name: "Clear" });

    // Keyboard operability is observable through focus movement: arrow keys move
    // focus between toolbar buttons, which is the behavior Requirement 10.3
    // requires. (The roving tab-stop's initial single-tab-stop state is asserted
    // in the test above.)
    pen.focus();
    expect(pen).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(eraser).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(clear).toHaveFocus();

    // Wraps from the last item back to the first.
    await user.keyboard("{ArrowRight}");
    expect(pen).toHaveFocus();

    // ArrowLeft wraps from the first item to the last.
    await user.keyboard("{ArrowLeft}");
    expect(clear).toHaveFocus();

    // Home/End jump to the ends.
    await user.keyboard("{Home}");
    expect(pen).toHaveFocus();
    await user.keyboard("{End}");
    expect(clear).toHaveFocus();
  });

  it("keeps the roving tab stop on the focused button after navigation (Req 10.3)", async () => {
    const user = userEvent.setup();
    render(<ToolbarFixture />);

    const pen = screen.getByRole("button", { name: "Pen" });
    const eraser = screen.getByRole("button", { name: "Eraser" });
    const clear = screen.getByRole("button", { name: "Clear" });

    // Regression guard: a fresh context value object on every render used to
    // change the provider identity whenever `activeId` changed, retriggering
    // each ToolbarButton's register/unregister effect and snapping the roving
    // tab stop back to the first button after each arrow keypress. The tab stop
    // must instead follow the focused button so Tab returns to where the user
    // last was.
    pen.focus();
    await user.keyboard("{ArrowRight}");
    expect(eraser).toHaveFocus();
    // The single tab stop moved to the focused button — not reset to the first.
    expect(pen).toHaveAttribute("tabindex", "-1");
    expect(eraser).toHaveAttribute("tabindex", "0");
    expect(clear).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowRight}");
    expect(clear).toHaveFocus();
    expect(pen).toHaveAttribute("tabindex", "-1");
    expect(eraser).toHaveAttribute("tabindex", "-1");
    expect(clear).toHaveAttribute("tabindex", "0");
  });
});

describe("Modal accessibility", () => {
  function ModalFixture() {
    const [open, setOpen] = useState(false);
    return (
      <div>
        <button onClick={() => setOpen(true)}>Open settings</button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Board settings"
          footer={<button>Save</button>}
        >
          <button>First action</button>
          <Input label="Display name" />
        </Modal>
      </div>
    );
  }

  it("renders as a labelled modal dialog", async () => {
    const user = userEvent.setup();
    render(<ModalFixture />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Accessible name comes from the title via aria-labelledby (Req 10.7).
    expect(dialog).toHaveAccessibleName("Board settings");
  });

  it("moves focus into the dialog when opened", async () => {
    const user = userEvent.setup();
    render(<ModalFixture />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    // First focusable element receives focus on open (Requirement 10.6).
    expect(
      screen.getByRole("button", { name: "First action" }),
    ).toHaveFocus();
  });

  it("traps focus by wrapping Tab and Shift+Tab within the dialog (Req 10.3)", async () => {
    const user = userEvent.setup();
    render(<ModalFixture />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));

    const first = screen.getByRole("button", { name: "First action" });
    const save = screen.getByRole("button", { name: "Save" });

    expect(first).toHaveFocus();

    // Shift+Tab from the first focusable wraps to the last.
    await user.tab({ shift: true });
    expect(save).toHaveFocus();

    // Tab from the last focusable wraps back to the first.
    await user.tab();
    expect(first).toHaveFocus();
  });

  it("closes on Escape and restores focus to the trigger (Req 10.6)", async () => {
    const user = userEvent.setup();
    render(<ModalFixture />);

    const trigger = screen.getByRole("button", { name: "Open settings" });
    await user.click(trigger);

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // Dialog is dismissed and focus returns to the element that opened it.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
