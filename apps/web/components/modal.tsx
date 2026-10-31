"use client";

// Modal on Radix Dialog: focus trap + return, Escape, scroll-lock, portal and
// aria wiring come from Radix (they were hand-rolled here before v3). The
// public API is unchanged so every existing caller keeps working.
import { type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import clsx from "clsx";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="v3-overlay fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className={clsx(
            "v3-pop fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[14px] border border-line bg-panel shadow-[var(--elev-4)] outline-none",
            SIZES[size],
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-semibold tracking-tight text-fg">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs leading-relaxed text-fg-3">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="focus-ring rounded-lg p-1 text-fg-3 transition-colors hover:bg-hover hover:text-fg"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </Dialog.Close>
          </div>
          <div className="px-6 py-5">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-3 border-t border-line px-6 py-4">{footer}</div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  onCancel: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}

// Shared replacement for native confirm()/prompt() dialogs — same
// Escape/focus-trap/scroll-lock behavior as Modal, consistent styling.
export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onCancel,
  onConfirm,
  confirming = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-2 hover:bg-hover"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50",
              tone === "danger" ? "bg-bad text-canvas hover:opacity-90" : "bg-accent-strong text-on-accent hover:bg-accent",
            )}
          >
            {confirming ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

export function ModalField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-zinc-600">{hint}</p>}
    </div>
  );
}
