import { useState } from "react";
import { User } from "lucide-react";
import { Button, Input, Modal } from "../../../components/ui";

// ─── JoinModal (Tier A — floating chrome) ─────────────────────────────
// Name-entry gate shown before joining a board. Uses the accessible Modal
// primitive (focus trap, Escape-to-close, focus restore) from the design system.

export function JoinModal({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onSubmit(trimmed);
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title="Join board"
      footer={
        <Button onClick={submit} className="brand-gradient w-full shadow-[var(--shadow-glow)]">
          Enter board
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-5">
        <div className="brand-gradient flex h-14 w-14 items-center justify-center rounded-xl shadow-[var(--shadow-glow)]">
          <User className="h-7 w-7 text-text-on-primary" />
        </div>
        <p className="text-center text-sm leading-relaxed text-text-muted">
          Enter your name so others can see who's drawing.
        </p>
        <div className="w-full">
          <Input
            label="Display name"
            hideLabel
            placeholder="Your name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            maxLength={20}
          />
        </div>
      </div>
    </Modal>
  );
}
