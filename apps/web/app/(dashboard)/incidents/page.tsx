"use client";

// Incidents (ADR 0056): anomaly and SLO-burn incidents opened by the
// observability sweep. Detection is deterministic; a model only writes the
// summary, and only when it cites the linked runs.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Activity, RefreshCw } from "lucide-react";
import { api, type Incident } from "@/lib/api";
import { incidentTone, kindLabel } from "@/lib/observability";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { TonePill } from "@/components/tone-pill";
import { useToast } from "@/components/toast";
import { useCan } from "@/components/role-gate";

const FILTERS = [
  { id: "active", label: "Active" },
  { id: "resolved", label: "Resolved" },
  { id: "", label: "All" },
] as const;

export default function IncidentsPage() {
  return (
    <Suspense fallback={null}>
      <Incidents />
    </Suspense>
  );
}

// The server returns at most this many (newest first, resolved last).
const LIST_CAP = 200;

function Incidents() {
  const toast = useToast();
  const agent = useSearchParams().get("agent") || undefined;
  const canScan = useCan("agents:write");
  const [filter, setFilter] = useState<string>("active");
  const [items, setItems] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Only the newest request may write state, so a slow response for the
  // previous filter can't land after the current one.
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const next = await api.listIncidents({ status: filter || undefined, agent });
      if (id !== reqId.current) return;
      setItems(next);
      setError(null);
    } catch (e) {
      if (id !== reqId.current) return;
      setError(e instanceof Error ? e.message : "Failed to load incidents");
    }
  }, [filter, agent]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api.scanIncidents();
      toast.success(r.opened ? `${r.opened} new incident${r.opened === 1 ? "" : "s"}` : "No new incidents");
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Incidents"
        description={agent ? `Anomalies and SLO burn on ${agent}. Every acknowledge and resolve is recorded.` : "Anomalies and SLO burn detected on your agents in production. Every acknowledge and resolve is recorded."}
        action={
          canScan ? (
            <Button variant="secondary" size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={scanning} onClick={scan}>
              Scan now
            </Button>
          ) : undefined
        }
      />
      <div className="mx-auto w-full max-w-5xl px-6 py-6 md:px-8">
        <div className="mb-4 flex gap-1" role="group" aria-label="Filter incidents">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={
                "focus-ring rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors " +
                (filter === f.id ? "bg-raised text-fg" : "text-fg-3 hover:text-fg-2")
              }
            >
              {f.label}
            </button>
          ))}
        </div>

        {error ? (
          <p role="alert" className="rounded-[12px] border border-bad/40 bg-bad-soft p-4 text-[13px] text-bad">
            {error}
          </p>
        ) : items === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Activity}
            size="compact"
            title={filter === "active" ? "No active incidents" : "No incidents"}
            description="When an agent's cost, latency, error rate, tool use or quality shifts well outside its own baseline, or burns its SLO error budget, it shows up here."
          />
        ) : (
          <ul className="divide-y divide-line rounded-[12px] border border-line bg-panel">
            {items.map((i) => (
              <li key={i.id}>
                <Link href={`/incidents/${i.id}`} className="flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-hover">
                  <div className="flex flex-wrap items-center gap-2">
                    <TonePill tone={incidentTone(i)}>{i.status === "resolved" ? "resolved" : i.severity}</TonePill>
                    {i.status === "acknowledged" && <TonePill tone="muted">acknowledged</TonePill>}
                    <span className="text-sm font-medium text-fg">{i.title}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-fg-3">{i.summary}</p>
                  <p className="text-[11px] text-fg-3">
                    <span className="font-mono">{i.agentName}</span> · {kindLabel(i.kind)} · {i.affectedRunIds.length} run
                    {i.affectedRunIds.length === 1 ? "" : "s"} · {new Date(i.openedAt).toLocaleString()}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {items && items.length >= LIST_CAP && (
          <p className="mt-2 text-[12px] text-fg-3">Showing the newest {LIST_CAP}. Narrow with a status filter to see older ones.</p>
        )}
      </div>
    </div>
  );
}
