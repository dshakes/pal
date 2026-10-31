"use client";

// /runs — every run in the workspace, newest first, on real API data.
// One sortable, keyboard-navigable table; filter by status, agent and session,
// search by id or agent. While anything is queued or running the list
// refreshes itself so the page stays live. Open a run for its trace.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertCircle, Layers, Play, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useAgents, useRuns } from "@/lib/hooks";
import { api } from "@/lib/api";
import { formatCost, formatDuration } from "@/lib/format";
import { ts } from "@/lib/overview";
import type { Run, RunStatus } from "@/lib/types";
import { runFilterFromQuery, sessionSizes, type RunStatusFilter } from "@/lib/runs-view";
import { useToast } from "@/components/toast";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button } from "@/components/button";
import { ConfirmModal } from "@/components/modal";
import { DataTable, type Column } from "@/components/data-table";
import { StatusBadge } from "@/components/status-badge";
import { useCan } from "@/components/role-gate";
import { useAgentSurface } from "@/components/agent-surface";
import { Kbd } from "@/components/ui";

const STATUS_FILTERS: Array<[RunStatusFilter, string]> = [
  ["all", "All"],
  ["running", "Running"],
  ["queued", "Queued"],
  ["succeeded", "Succeeded"],
  ["failed", "Failed"],
  ["cancelled", "Cancelled"],
];

function duration(r: Run): number | null {
  if (!r.startedAt) return null;
  const end = r.finishedAt ? ts(r.finishedAt) : Date.now();
  return Math.max(0, end - ts(r.startedAt));
}

export default function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const canDelete = useCan("runs:execute");
  const initial = runFilterFromQuery(searchParams);
  const [status, setStatus] = useState<RunStatusFilter>(initial.status);
  const [agent, setAgent] = useState(initial.agent);
  const [session, setSession] = useState(initial.session);
  const [query, setQuery] = useState(initial.q);
  const [confirm, setConfirm] = useState<Run | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Mirror filters into the URL so a filtered view is linkable.
  useEffect(() => {
    const q = new URLSearchParams();
    if (status !== "all") q.set("status", status);
    if (agent) q.set("agent", agent);
    if (session) q.set("session", session);
    if (query) q.set("q", query);
    const next = q.toString();
    if (next !== window.location.search.replace(/^\?/, "")) router.replace(next ? `?${next}` : "/runs", { scroll: false });
  }, [status, agent, session, query, router]);

  const { agents } = useAgents();
  const { runs, loading, error, refresh } = useRuns({
    agentName: agent || undefined,
    status: status !== "all" ? (status as RunStatus) : undefined,
  });

  // Live: refresh every 3s while anything is still in flight.
  const inFlight = runs.some((r) => r.status === "running" || r.status === "queued");
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [inFlight, refresh]);

  const sizes = useMemo(() => sessionSizes(runs), [runs]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((r) =>
      (!session || r.sessionId === session) &&
      (!q || r.id.toLowerCase().includes(q) || r.agentName.toLowerCase().includes(q)),
    );
  }, [runs, session, query]);

  const failed = visible.filter((r) => r.status === "failed");
  useAgentSurface({
    page: "Runs",
    facts: [
      `${visible.length} runs shown${status !== "all" ? ` (status ${status})` : ""}${agent ? ` for ${agent}` : ""}`,
      `${failed.length} failed, ${visible.filter((r) => r.status === "running").length} running`,
    ],
    suggestions: failed.length ? ["Why did my last run fail?", "Which agent fails most?"] : ["How many agents do I have?"],
    explain: failed.slice(0, 5).map((r) => ({ id: r.id, label: `${r.agentName} run ${r.id.slice(0, 8)} failed`, sub: r.error?.message, request: { kind: "run" as const, runId: r.id } })),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const doDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      await api.deleteRun(confirm.id);
      toast.success(`Deleted run ${confirm.id.slice(0, 8)}`);
      setConfirm(null);
      void refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t delete the run");
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<Run>[] = [
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "agent",
      header: "Agent",
      sortable: true,
      sortFn: (a, b) => a.agentName.localeCompare(b.agentName),
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px] text-fg">{r.agentName}</p>
          <p className="font-mono text-[11.5px] text-fg-3">{r.id.slice(0, 8)}</p>
        </div>
      ),
    },
    {
      key: "session",
      header: "Session",
      hideOnMobile: true,
      render: (r) =>
        r.sessionId && (sizes.get(r.sessionId) ?? 0) > 1 ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setSession(r.sessionId!); }}
            className="focus-ring inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[12px] text-fg-2 hover:border-line-strong hover:text-fg"
            title="Show only this session"
          >
            <Layers className="h-3 w-3" aria-hidden /> {sizes.get(r.sessionId)} runs
          </button>
        ) : (
          <span className="text-fg-3">—</span>
        ),
    },
    {
      key: "duration",
      header: "Duration",
      align: "right",
      hideOnMobile: true,
      sortable: true,
      sortFn: (a, b) => (duration(a) ?? -1) - (duration(b) ?? -1),
      render: (r) => {
        const d = duration(r);
        return <span className="num text-fg-2">{d === null ? "—" : formatDuration(d)}</span>;
      },
    },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortable: true,
      sortFn: (a, b) => a.costUsd - b.costUsd,
      render: (r) => <span className="num text-fg-2">{formatCost(r.costUsd)}</span>,
    },
    {
      key: "when",
      header: "Started",
      hideOnMobile: true,
      sortable: true,
      sortFn: (a, b) => ts(a.createdAt) - ts(b.createdAt),
      className: "whitespace-nowrap text-fg-3",
      render: (r) => formatDistanceToNowStrict(ts(r.createdAt), { addSuffix: true }),
    },
  ];

  const hasFilter = status !== "all" || !!agent || !!session || !!query;
  // Only show the Session column when some session actually spans runs.
  const anySession = [...sizes.values()].some((n) => n > 1);
  const shown = anySession ? columns : columns.filter((c) => c.key !== "session");

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Runs"
        badge={loading && runs.length === 0 ? undefined : <CountBadge count={visible.length} />}
        description="Every run in this workspace, newest first. Open one for its step-by-step trace, output and cost."
        secondaryAction={
          <Button variant="ghost" size="md" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />

      <div className="mx-auto w-full max-w-[1200px] space-y-3 px-4 pb-8 pt-4 md:px-8">
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <div role="radiogroup" aria-label="Filter by status" className="flex gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel p-0.5">
            {STATUS_FILTERS.map(([v, l]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={status === v}
                onClick={() => setStatus(v)}
                className={clsx(
                  "focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors",
                  status === v ? "bg-hover font-medium text-fg" : "text-fg-3 hover:text-fg",
                )}
              >
                {v === "running" && inFlight && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent status-running" />}
                {l}
              </button>
            ))}
          </div>
          <div className="flex flex-1 flex-col gap-2.5 sm:flex-row lg:justify-end">
            <label className="sm:w-52">
              <span className="sr-only">Agent</span>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="h-8 w-full rounded-lg border border-line bg-panel px-2.5 text-[13px] text-fg"
              >
                <option value="">All agents</option>
                {agents.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
              </select>
            </label>
            <label className="relative flex-1 sm:max-w-[300px]">
              <span className="sr-only">Search runs</span>
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by run id or agent"
                className="h-8 w-full rounded-lg border border-line bg-panel pl-8 pr-8 text-[13px] text-fg placeholder:text-fg-3"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>
            </label>
          </div>
        </div>

        {session && (
          <div className="flex items-center gap-2 text-[13px] text-fg-2">
            <Layers className="h-3.5 w-3.5 text-fg-3" aria-hidden />
            Showing one session
            <span className="font-mono text-[12px] text-fg-3">{session.slice(0, 8)}</span>
            <button type="button" onClick={() => setSession("")} className="focus-ring inline-flex items-center gap-1 rounded px-1 text-accent hover:underline">
              <X className="h-3 w-3" aria-hidden /> Show all
            </button>
          </div>
        )}

        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-[12px] border border-bad/40 bg-bad-soft px-4 py-3.5">
            <AlertCircle className="h-4 w-4 text-bad" aria-hidden />
            <p className="flex-1 text-[13px] text-fg">Couldn’t load runs: {error.message}</p>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}>Try again</Button>
          </div>
        ) : (
          <DataTable<Run>
            label="Runs"
            loading={loading && runs.length === 0}
            rows={visible}
            rowKey={(r) => r.id}
            pageSize={25}
            defaultSort={{ key: "when", dir: "desc" }}
            onRowClick={(r) => router.push(`/runs/${encodeURIComponent(r.id)}`)}
            columns={shown}
            rowActions={canDelete ? [{ label: "Delete run", icon: Trash2, variant: "danger", onClick: (r) => setConfirm(r) }] : undefined}
            emptyIcon={Play}
            emptyTitle={hasFilter ? "No runs match" : "No runs yet"}
            emptyDescription={
              hasFilter
                ? "Try another status, agent or search."
                : "Test an agent from its page, or call POST /v1/runs. Each run lands here with its trace, output and cost."
            }
            emptyAction={
              hasFilter ? (
                <Button variant="secondary" size="sm" onClick={() => { setStatus("all"); setAgent(""); setSession(""); setQuery(""); }}>Clear filters</Button>
              ) : (
                <Button variant="primary" size="sm" onClick={() => router.push("/agents")}>Go to agents</Button>
              )
            }
          />
        )}
      </div>

      <ConfirmModal
        open={confirm !== null}
        title={`Delete run ${confirm?.id.slice(0, 8) ?? ""}?`}
        description="The run and its trace are removed from history. This can’t be undone."
        confirmLabel="Delete run"
        tone="danger"
        confirming={deleting}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}
