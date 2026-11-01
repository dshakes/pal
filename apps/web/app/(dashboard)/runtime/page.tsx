"use client";

// Sandboxes (v3): the tenant's microVMs, on real data only. There is no demo
// fleet and no simulated metrics; an unreachable API is an error with a retry,
// never an empty list.
//   GET /v1/runtime/vms (newest 100)  ·  GET /v1/runtime/cluster  ·  DELETE /v1/runtime/vms/{id}
// Polled every 5s; a failed poll keeps the last good rows and says they're stale.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertTriangle, Plus, RefreshCw, Server } from "lucide-react";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { DataTable, type Column } from "@/components/data-table";
import { useCan } from "@/components/role-gate";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import { runtimeFailure, VM_LIST_LIMIT } from "@/lib/sandbox";
import { cappedNote } from "@/lib/promotion";
import type { ClusterSummary, VmRow } from "@/lib/runtime-types";
import { ScheduleModal } from "./schedule-modal";
import { VmState } from "./vm-state";

const ago = (iso?: string | null) => (iso ? `${formatDistanceToNowStrict(new Date(iso))} ago` : "—");

export default function SandboxesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canRead = useCan("runtime:read");
  const canSchedule = useCan("runtime:admin");
  const [vms, setVms] = useState<VmRow[] | null>(null);
  const [cluster, setCluster] = useState<ClusterSummary | null | "unavailable">(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, cl] = await Promise.all([
        runtimeApi.get<VmRow[]>(`/v1/runtime/vms?limit=${VM_LIST_LIMIT}`),
        runtimeApi.get<ClusterSummary>("/v1/runtime/cluster").catch(() => "unavailable" as const),
      ]);
      setVms(Array.isArray(list) ? list : []);
      setCluster(cl);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setError(runtimeFailure(err).message);
    }
  }, []);

  useEffect(() => {
    if (!canRead) return;
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load, canRead]);

  // Deep link: the ⌘K palette's "Schedule a workload" action lands here with ?schedule=1.
  useEffect(() => {
    if (searchParams.get("schedule") === "1" && canSchedule) setScheduleOpen(true);
  }, [searchParams, canSchedule]);

  const rows = useMemo(
    () => (vms ?? []).filter((v) => showEnded || (v.state !== "terminated" && v.state !== "failed")),
    [vms, showEnded],
  );
  const counts = useMemo(() => {
    const c = { running: 0, paused: 0, failed: 0, ended: 0 };
    for (const v of vms ?? []) {
      if (v.state === "running") c.running++;
      else if (v.state === "paused") c.paused++;
      else if (v.state === "failed") c.failed++;
      if (v.state === "terminated" || v.state === "failed") c.ended++;
    }
    return c;
  }, [vms]);

  const columns: Column<VmRow>[] = [
    {
      key: "id",
      header: "Sandbox",
      sortable: true,
      sortFn: (a, b) => a.vmId.localeCompare(b.vmId),
      render: (v) => (
        <span className="block min-w-0 truncate font-mono text-[12.5px] text-fg" title={v.vmId}>
          {v.vmId}
          {v.parentVmId && <span className="ml-2 font-sans text-[11px] text-fg-3">fork</span>}
        </span>
      ),
    },
    {
      key: "state",
      header: "State",
      sortable: true,
      sortFn: (a, b) => a.state.localeCompare(b.state),
      render: (v) => (
        <div className="min-w-0">
          <VmState state={v.state} />
          {v.state === "failed" && v.stateReason && (
            <p className="mt-0.5 truncate text-[11px] text-bad" title={v.stateReason}>
              {v.stateReason}
            </p>
          )}
        </div>
      ),
    },
    { key: "iso", header: "Isolation", hideOnMobile: true, render: (v) => v.isolationClass || "—" },
    { key: "node", header: "Node", hideOnMobile: true, render: (v) => <span className="block truncate">{v.node ?? "—"}{v.region ? ` · ${v.region}` : ""}</span> },
    {
      key: "created",
      header: "Created",
      sortable: true,
      sortFn: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
      render: (v) => <span className="num text-fg-3">{ago(v.createdAt)}</span>,
    },
    { key: "hb", header: "Heartbeat", hideOnMobile: true, render: (v) => <span className="num text-fg-3">{ago(v.lastHeartbeatAt)}</span> },
  ];

  if (!canRead) {
    return (
      <div>
        <PageHeader title="Sandboxes" description="Isolated microVMs your agents run in." />
        <div className="p-6 md:p-8">
          <EmptyState icon={Server} title="Your role can't view sandboxes" description="Sandboxes are visible to owners, admins and members." />
        </div>
      </div>
    );
  }

  const cap = vms ? cappedNote(vms.length, VM_LIST_LIMIT, "sandboxes") : null;

  return (
    <div>
      <PageHeader
        title="Sandboxes"
        description="Isolated microVMs your agents run in: state, placement, and lifecycle."
        badge={vms ? <CountBadge count={rows.length} /> : undefined}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />}
              onClick={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={!canSchedule}
              title={canSchedule ? undefined : "Scheduling needs an owner or admin"}
              onClick={() => setScheduleOpen(true)}
            >
              Schedule
            </Button>
          </div>
        }
      />
      <div className="space-y-4 p-6 md:p-8">
        {error && vms === null ? (
          <EmptyState icon={AlertTriangle} title="Couldn't load sandboxes" description={error} actionLabel="Retry" onAction={() => void load()} />
        ) : (
          <>
            {error && (
              <p role="alert" className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
                Couldn&apos;t refresh ({error}). Showing the last successful load.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-fg-2">
              <span><span className="num font-semibold text-fg">{counts.running}</span> running</span>
              <span><span className="num font-semibold text-fg">{counts.paused}</span> paused</span>
              <span><span className={counts.failed > 0 ? "num font-semibold text-bad" : "num font-semibold text-fg"}>{counts.failed}</span> failed</span>
              <span className="text-fg-3">
                {cluster === null ? "Capacity: loading" : cluster === "unavailable"
                  ? "Capacity: unavailable"
                  : `${cluster.nodes?.length ?? 0} node${(cluster.nodes?.length ?? 0) === 1 ? "" : "s"}${cluster.warm_pool ? ` · warm pool ${cluster.warm_pool.available}/${cluster.warm_pool.target}` : ""}`}
              </span>
              <label className="ml-auto inline-flex items-center gap-2 text-fg-2">
                <input type="checkbox" className="focus-ring h-3.5 w-3.5 accent-[var(--color-accent)]" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} />
                Show terminated and failed ({counts.ended})
              </label>
            </div>
            <DataTable
              label="Sandboxes"
              columns={columns}
              rows={rows}
              rowKey={(v) => v.vmId}
              loading={vms === null}
              pageSize={25}
              fixed
              defaultSort={{ key: "created", dir: "desc" }}
              onRowClick={(v) => router.push(`/runtime/${encodeURIComponent(v.vmId)}`)}
              emptyIcon={Server}
              emptyTitle="No sandboxes"
              emptyDescription="Schedule a headless agent from here, or use `pal run <agent.yaml>`."
              emptyAction={canSchedule ? <Button variant="primary" size="sm" onClick={() => setScheduleOpen(true)}>Schedule a workload</Button> : undefined}
            />
            {cap && <p className="text-[12px] text-fg-3">{cap}</p>}
          </>
        )}
      </div>
      <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} onScheduled={load} />
    </div>
  );
}
