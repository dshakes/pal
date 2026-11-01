"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Save,
  Rocket,
  Play,
  Check,
  Loader2,
  Code,
  Undo2,
  Redo2,
} from "lucide-react";
import clsx from "clsx";

interface ToolbarProps {
  agentName: string;
  onSave: () => void;
  onDeploy: () => void;
  onTestRun: () => void;
  onExportCode: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

export function Toolbar({
  agentName,
  onSave,
  onDeploy,
  onTestRun,
  onExportCode,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: ToolbarProps) {
  const router = useRouter();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle"
  );

  function handleSave() {
    setSaveState("saving");
    onSave();
    // Simulate save completing
    setTimeout(() => {
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    }, 600);
  }

  return (
    <div className="flex h-12 items-center justify-between border-b border-line bg-panel px-4">
      {/* Left: back + agent name */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push(`/agents/${agentName}`)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="h-4 w-px bg-raised" />
        <span className="text-sm font-medium text-fg-2">{agentName}</span>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[11px] font-medium text-fg-3">
          EDITOR
        </span>

        {/* Undo / Redo */}
        <div className="ml-2 h-4 w-px bg-raised" />
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-2"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-2"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Center: auto-save indicator */}
      <div className="flex items-center gap-1.5">
        {saveState === "saving" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-fg-3" />
            <span className="text-xs text-fg-3">Saving...</span>
          </>
        )}
        {saveState === "saved" && (
          <>
            <Check className="h-3 w-3 text-ok" />
            <span className="text-xs text-ok">Saved</span>
          </>
        )}
        {saveState === "idle" && (
          <span className="text-xs text-fg-3">All changes saved</span>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onExportCode}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-hover"
          title="Export as Code"
        >
          <Code className="h-3 w-3" />
          Export
        </button>
        <button
          onClick={onTestRun}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fg-2 transition-colors hover:bg-hover"
        >
          <Play className="h-3 w-3" />
          Test Run
        </button>
        <button
          onClick={handleSave}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
            saveState === "saving"
              ? "border-line-strong text-fg-3"
              : "border-line-strong text-fg-2 hover:bg-hover"
          )}
          disabled={saveState === "saving"}
        >
          <Save className="h-3 w-3" />
          Save
        </button>
        <button
          onClick={onDeploy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-black transition-colors hover:opacity-90"
        >
          <Rocket className="h-3 w-3" />
          Deploy
        </button>
      </div>
    </div>
  );
}
