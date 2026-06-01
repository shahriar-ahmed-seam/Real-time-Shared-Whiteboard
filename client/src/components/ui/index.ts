/**
 * Accessible UI component library (design-token driven).
 *
 * Every component here consumes design tokens from `client/src/index.css`
 * (via token-backed Tailwind utilities or `var(--token)`) and ships with
 * built-in accessibility: visible focus rings, ARIA roles/labels, >=44px touch
 * targets, focus management, and text alternatives. No hardcoded color/size
 * style literals.
 */
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Input } from "./Input";
export type { InputProps } from "./Input";

export { Modal } from "./Modal";
export type { ModalProps } from "./Modal";

export { Tooltip } from "./Tooltip";
export type { TooltipProps } from "./Tooltip";

export { Toolbar, ToolbarButton } from "./Toolbar";
export type { ToolbarProps, ToolbarButtonProps } from "./Toolbar";

export { Popover } from "./Popover";
export type { PopoverProps } from "./Popover";

export { ToastProvider } from "./Toast";
export { useToast } from "./toastContext";
export type { ToastOptions, ToastVariant } from "./toastContext";
