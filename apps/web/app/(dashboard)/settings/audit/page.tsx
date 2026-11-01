"use client";

// Settings -> Audit log. There is no single tenant-wide audit endpoint, so this
// merges the two that exist (promotions + sandboxes; lib/audit) and says so.
// Visible to owner/admin only (actors and principals are shown) - UX gating,
// lib/rbac-matrix.ts.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import { runtimeApi } from "@/lib/runtime-api";
import { parseApiError } from "@/lib/mcp";
import {
  PAGE, filterAudit, mergeAudit, nextPromotionLimit, parsePromotionAudit, parseSandboxAudit,
  type AuditRow, type AuditSource,
} from "@/lib/audit";
import { useCan } from "@/components/role-gate";
import { Button } from "@/components/button";
import { DataTable, type Column } from "@/components/data-table";

const SOURCE_LABEL: Record<AuditSource, string> = { promotion: "Promotion", sandbox: "Sandbox" };
const inputCls = "rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent";

const COLUMNS: Column<AuditRow>[] = [
  { key: "at", header: "When", width: 170, render: (r) => <time dateTime={r.at} className="whitespace-nowrap text-xs text-fg-2">{new Date(r.at).toLocaleString()}</time> },
  { key: "source", header: "Source", width: 100, hideOnMobile: true, render: (r) => <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-fg-2">{SOURCE_LABEL[r.source]}</span> },
  { key: "action", header: "Action", render: (r) => <span className="font-mono text-xs text-fg">{r.action}</span> },
  { key: "actor", header: "Actor", hideOnMobile: true, render: (r) => <span className="break-all text-xs text-fg-2">{r.actor}</span> },
  { key: "subject", header: "Subject", hideOnMobile: true, render: (r) => <span className="break-all font-mono text-[11px] text-fg-3">{r.subject || "-"}</span> },
  { key: "detail", header: "Detail", hideOnMobile: true, render: (r) => <span className="break-words text-[11px] text-fg-3">{r.detail || "-"}</span> },
];

export default function AuditLogPage() {
  const allowed = useCan("audit:read");
  const [promoRows, setPromoRows] = useState<AuditRow[]>([]);
  const [promoLimit, setPromoLimit] = useState(PAGE);
  const [promoCount, setPromoCount] = useState(0);
  const [promoErr, setPromoErr] = useState<string | null>(null);
  const [sandboxRows, setSandboxRows] = useState<AuditRow[]>([]);
  const [sandboxCursor, setSandboxCursor] = useState(0);
  const [sandboxFull, setSandboxFull] = useState(false); // last page was full, so older rows may exist
  const [sandboxErr, setSandboxErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [source, setSource] = useState<AuditSource | "all">("all");
  const [query, setQuery] = useState("");

  const loadPromotions = useCallback(async (limit: number) => {
    try {
      const rows = parsePromotionAudit(await runtimeApi.get<unknown>(`/v1/promotions/audit?limit=${limit}`));
      setPromoRows(rows);
      setPromoCount(rows.length);
      setPromoLimit(limit);
      setPromoErr(null);
    } catch (e) {
      setPromoErr(parseApiError(e).message);
    }
  }, []);

  const loadSandbox = useCallback(async (before: number) => {
    try {
      const page = parseSandboxAudit(await runtimeApi.get<unknown>(`/v1/runtime/audit?limit=${PAGE}${before > 0 ? `&before=${before}` : ""}`));
      setSandboxRows((prev) => mergeAudit(prev, page.rows));
      setSandboxCursor(page.nextBefore);
      setSandboxFull(page.count >= PAGE && page.nextBefore > 0);
      setSandboxErr(null);
    } catch (e) {
      setSandboxErr(parseApiError(e).message);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void Promise.all([loadPromotions(PAGE), loadSandbox(0)]).finally(() => setLoading(false));
  }, [allowed, loadPromotions, loadSandbox]);

  const rows = useMemo(() => filterAudit(mergeAudit(promoRows, sandboxRows), source, query), [promoRows, sandboxRows, source, query]);
  const nextLimit = nextPromotionLimit(promoLimit);
  const promoMore = promoCount >= promoLimit && nextLimit !== null;
  const promoAtCap = promoCount >= promoLimit && nextLimit === null;

  if (!allowed) {
    return <div role="status" className="rounded-xl border border-line bg-panel p-5 text-sm text-fg-3">The audit log is for workspace owners and admins.</div>;
  }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-line bg-panel p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg"><ScrollText className="h-4 w-4 text-accent" /> Audit log</h2>
        <p className="mt-1 text-[11px] text-fg-3">
          Promotion decisions and sandbox events for this workspace, newest first. The control plane has no single audit feed yet, so these are the two streams that exist;
          per-agent identity and policy changes are on each agent&apos;s Security tab. Values that look like secrets are hidden.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="Source" className={inputCls} value={source} onChange={(e) => setSource(e.target.value as AuditSource | "all")}>
            <option value="all">All sources</option>
            <option value="promotion">Promotions</option>
            <option value="sandbox">Sandboxes</option>
          </select>
          <input aria-label="Filter" className={`${inputCls} min-w-0 flex-1 sm:max-w-xs`} placeholder="Filter by action, actor, subject" value={query} onChange={(e) => setQuery(e.target.value)} />
          <span className="text-[11px] text-fg-3">{rows.length} shown</span>
        </div>
        {promoErr && <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">Promotion records could not be loaded: {promoErr}</p>}
        {sandboxErr && <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-xs text-bad">Sandbox events could not be loaded: {sandboxErr}</p>}
      </section>

      <DataTable
        label="Audit log"
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.key}
        loading={loading}
        pageSize={25}
        emptyIcon={ScrollText}
        emptyTitle={query || source !== "all" ? "Nothing matches" : "No audit records yet"}
        emptyDescription={query || source !== "all" ? "Try a different source or filter." : "Promotions and sandbox activity will appear here."}
      />

      <div className="flex flex-wrap items-center gap-3">
        {promoMore && (
          <Button size="sm" variant="secondary" loading={more} onClick={async () => { setMore(true); await loadPromotions(nextLimit ?? promoLimit); setMore(false); }}>
            Load more promotion records
          </Button>
        )}
        {sandboxFull && (
          <Button size="sm" variant="secondary" loading={more} onClick={async () => { setMore(true); await loadSandbox(sandboxCursor); setMore(false); }}>
            Load older sandbox events
          </Button>
        )}
        {promoAtCap && <p className="text-[11px] text-fg-3">Showing the latest {promoLimit} promotion records; the API offers nothing older.</p>}
      </div>
    </div>
  );
}
