"use client";

// Settings -> Data protection (ADR 0030): per-workspace egress DLP rules that
// the sandbox egress broker applies to outbound requests. Wired to
// /v1/egress/dlp-policy*. Read for everyone; changes need settings:write
// (UX gating, lib/rbac-matrix.ts).

import { useCallback, useEffect, useState } from "react";
import { Lock, Pencil, Plus, Trash2 } from "lucide-react";
import { runtimeApi } from "@/lib/runtime-api";
import { parseApiError } from "@/lib/mcp";
import {
  DETECTORS, DETECTOR_LABEL, MODES, MODE_LABEL, draftFromRule, emptyDraft, hasBlockRule, parseDlpRules,
  toUpsertBody, usesThreshold, validateDraft, type DlpRule, type RuleDraft,
} from "@/lib/dlp";
import { useCan } from "@/components/role-gate";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ConfirmModal, Modal, ModalField } from "@/components/modal";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/settings/toast";

const inputCls = "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent";
const card = "rounded-xl border border-line bg-panel p-5";

export default function DlpSettingsPage() {
  const { toast } = useToast();
  const canWrite = useCan("settings:write");
  const [rules, setRules] = useState<DlpRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [editing, setEditing] = useState(false); // editing an existing rule: id is its key
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<DlpRule | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    try {
      setRules(parseDlpRules(await runtimeApi.get<unknown>("/v1/egress/dlp-policy")));
      setLoadError(null);
    } catch (e) {
      setRules((prev) => prev ?? []);
      setLoadError(parseApiError(e).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => { setDraft(emptyDraft()); setEditing(false); setFormError(null); };
  const openEdit = (r: DlpRule) => { setDraft(draftFromRule(r)); setEditing(true); setFormError(null); };

  const save = async () => {
    if (!draft) return;
    const invalid = validateDraft(draft);
    if (invalid) { setFormError(invalid); return; }
    setSaving(true);
    setFormError(null);
    try {
      await runtimeApi.post("/v1/egress/dlp-policy/rules", toUpsertBody(draft));
      toast("success", `Rule "${draft.ruleId.trim()}" saved`);
      setDraft(null);
      await load();
    } catch (e) {
      setFormError(parseApiError(e).message); // includes the server's regex verdict
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!removeTarget) return;
    setRemoving(true);
    try {
      await runtimeApi.del(`/v1/egress/dlp-policy/rules/${encodeURIComponent(removeTarget.ruleId)}`);
      toast("success", `Rule "${removeTarget.ruleId}" deleted`);
      await load();
    } catch (e) {
      toast("error", `Could not delete the rule: ${parseApiError(e).message}`);
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className={card}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-fg"><Lock className="h-4 w-4 text-accent" /> Data protection</h2>
            <p className="mt-1 text-[11px] text-fg-3">
              Rules the sandbox egress broker applies to outbound requests from your agents&apos; sandboxes. Applied when a sandbox starts; running sandboxes keep their rules.
            </p>
          </div>
          {canWrite && <Button size="sm" className="shrink-0 whitespace-nowrap" icon={<Plus className="h-3 w-3" />} onClick={openNew}>Add rule</Button>}
        </div>

        <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-[11px] text-fg-3">
          Scans the request head and the first part of the body for TLS-terminated credential-injection hosts and plain-HTTP allowlisted hosts. It does not inspect opaque
          HTTPS tunnels, bytes past the cap, or encoded data, so it stops careless leaks, not a determined compromised workload.
        </p>
        {rules && hasBlockRule(rules) && (
          <p className="mt-2 rounded-lg bg-warn-soft px-3 py-2 text-[11px] text-warn">
            Block rules need the broker egress mode. On a node without it, a sandbox that would load a block rule is refused at start rather than run unprotected.
          </p>
        )}
        {loadError && <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">Could not load rules: {loadError}</p>}

        <div className="mt-4 space-y-2">
          {rules === null ? (
            <Skeleton className="h-14 w-full" />
          ) : rules.length === 0 && !loadError ? (
            <EmptyState size="compact" title="No rules yet" description="Without rules, nothing is scanned on the way out." actionLabel={canWrite ? "Add rule" : undefined} onAction={canWrite ? openNew : undefined} />
          ) : (
            rules.map((r) => (
              <div key={r.ruleId} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <p className="text-xs font-medium text-fg"><span className="font-mono">{r.ruleId}</span></p>
                  <p className="truncate text-[11px] text-fg-3">
                    {DETECTOR_LABEL[r.detector]}
                    {r.detector === "custom_regex" && r.pattern ? <> · <span className="font-mono">{r.pattern}</span></> : null}
                    {usesThreshold(r.detector) ? ` · after ${r.threshold} match${r.threshold === 1 ? "" : "es"}` : ""}
                  </p>
                </div>
                <span className={r.mode === "block" ? "rounded-full bg-bad-soft px-2 py-0.5 text-[10px] font-medium text-bad" : r.mode === "audit" ? "rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-medium text-warn" : "rounded-full bg-raised px-2 py-0.5 text-[10px] text-fg-3"}>
                  {MODE_LABEL[r.mode]}
                </span>
                {canWrite && (
                  <>
                    <button aria-label={`Edit ${r.ruleId}`} onClick={() => openEdit(r)} className="rounded p-1 text-fg-3 hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                    <button aria-label={`Delete ${r.ruleId}`} onClick={() => setRemoveTarget(r)} className="rounded p-1 text-fg-3 hover:bg-bad-soft hover:text-bad"><Trash2 className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
        {!canWrite && <p className="mt-3 text-[11px] text-fg-3">Only an owner or admin can change these rules.</p>}
      </section>

      <Modal
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={editing ? "Edit rule" : "Add rule"}
        description="Matched values are never logged; audit entries record only the decision."
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button loading={saving} onClick={save}>Save rule</Button></>}
      >
        {draft && (
          <div className="space-y-3">
            <ModalField label="Name" hint={editing ? "The name is the rule's key and can't change." : "e.g. block-cards"}>
              <input className={inputCls} aria-label="Rule name" value={draft.ruleId} disabled={editing} onChange={(e) => setDraft({ ...draft, ruleId: e.target.value })} />
            </ModalField>
            <ModalField label="Detector">
              <select className={inputCls} aria-label="Detector" value={draft.detector} onChange={(e) => setDraft({ ...draft, detector: e.target.value as RuleDraft["detector"] })}>
                {DETECTORS.map((d) => <option key={d} value={d}>{DETECTOR_LABEL[d]}</option>)}
              </select>
            </ModalField>
            {draft.detector === "custom_regex" && (
              <ModalField label="Pattern" hint="RE2 syntax. The control plane checks it when you save.">
                <input className={`${inputCls} font-mono`} aria-label="Pattern" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />
              </ModalField>
            )}
            {usesThreshold(draft.detector) && (
              <ModalField label="Matches before it fires" hint="One address or number is normal; set higher to catch bulk exports.">
                <input className={inputCls} aria-label="Threshold" inputMode="numeric" value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} />
              </ModalField>
            )}
            <ModalField label="Mode">
              <select className={inputCls} aria-label="Mode" value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as RuleDraft["mode"] })}>
                {MODES.map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
              </select>
            </ModalField>
            {formError && <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">{formError}</p>}
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={removeTarget !== null}
        title={`Delete ${removeTarget?.ruleId ?? "rule"}?`}
        description="Sandboxes started after this will no longer be scanned for it."
        confirmLabel="Delete rule"
        tone="danger"
        confirming={removing}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
