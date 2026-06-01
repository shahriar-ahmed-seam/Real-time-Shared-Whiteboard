/**
 * Shared helpers for the UI component library.
 *
 * These utilities contain no visual styling. All color/spacing/radius/motion
 * styling lives in design tokens (see `client/src/index.css`) and is applied via
 * token-backed Tailwind utility classes or `var(--token)` references only.
 */

/** Join conditional class names, dropping falsy values. */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Built-in, always-visible focus ring used by every interactive component.
 * Uses the `--color-focus` token (>=3:1 contrast on `--color-bg`, Req 10.6).
 * `focus-visible:outline` sets `outline-style: solid` so the 2px width renders
 * even though `outline-none` resets the default style at rest.
 */
export const focusRing = cn(
  "outline-none",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
);

/**
 * Selector matching elements that can receive keyboard focus. Used by the
 * Modal focus trap and the Popover focus manager.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Return the visible, focusable descendants of `container` in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  );
  return nodes.filter(
    (el) =>
      !el.hasAttribute("disabled") &&
      el.getAttribute("aria-hidden") !== "true" &&
      // offsetParent is null for display:none elements (good enough for our use).
      (el.offsetParent !== null || el === document.activeElement),
  );
}
