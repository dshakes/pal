"use client";

// /agents — the Runtime agent list. One dense, sortable, keyboard-navigable
// table on real data: each agent's last run, 24-hour volume and success rate
// come from /v1/runs; nothing is estimated. Filter by health, search with "/",
// open with Enter. Destructive actions are role-gated and confirmed.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import { AlertCircle, Bot, MessageSquare, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAgents, useRuns } from "@/lib/hooks";
import type { Agent, Run } from "@/lib/types";
import { ts } from "@/lib/overview";
import { getLastAgent, clearLastAgent } from "@/lib/last-agent";
import { useToast } from "@/components/toast";
import { PageHeader, CountBadge } from "@/components/page-header";
import { Button, LinkButton } from "@/components/button";
import { ConfirmModal } from "@/components/modal";
import { DataTable, type Column } from "@/components/data-table";
import { RoleGate, useCan } from "@/components/role-gate";
import { useAgentSurface } from "@/components/agent-surface";
import { Kbd } from "@/components/ui";

const DAY = 24 * 3_600_000;

type Health = "failing" | "healthy" | "idle";
type Filter = "all" | Health;

interface Row {
  agent: Agent;
  health: Health;
  last?: Run;
  runs24: number;
  failed24: number;
  success24: number | null;
}

function buildRows(agents: Agent[], runs: Run[], now: number): Row[] {
  const byAgent = new Map<string, Run[]>();
  for (const r of runs) {
    const list = byAgent.get(r.agentName) ?? [];
    list.push(r);
    byAgent.set(r.agentName, list);
  }
  return agents.map((agent) => {
    const mine = (byAgent.get(agent.name) ?? []).sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
    const day = mine.filter((r) => now - ts(r.createdAt) < DAY);
    const finished = day.filter((r) => r.status === "succeeded" || r.status === "failed");
    const failed24 = day.filter((r) => r.status === "failed").length;
    const last = mine[0];
    return {
      agent,
      last,
      runs24: day.length,
      failed24,
      success24: finished.length ? Math.round(((finished.length - failed24) / finished.length) * 100) : null,
      health: !last ? "idle" : last.status === "failed" ? "failing" : "healthy",
    };
  });
}

const FILTER_LABEL: Record<Filter, string> = { all: "All", failing: "Failing", healthy: "Healthy", idle: "Never run" };

export default function AgentsPage() {
  const router = useRouter();
  const toast = useToast();
  const canWrite = useCan("agents:write");
  const { agents, setAgents, loading, error, refresh } = useAgents();
  const { runs, loading: runsLoading } = useRuns({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmDelete, setConfirmDelete] = useState<Agent | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(() => buildRows(agents, runs, Date.now()), [agents, runs]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: rows.length, failing: 0, healthy: 0, idle: 0 };
    for (const r of rows) c[r.health] += 1;
    return c;
  }, [rows]);
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) =>
      (filter === "all" || r.health === filter) &&
      (!q || r.agent.name.toLowerCase().includes(q) || (r.agent.description ?? "").toLowerCase().includes(q)),
    );
  }, [rows, search, filter]);

  // "/" focuses search (Linear / GitHub convention).
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

  useAgentSurface({
    page: "Agents",
    facts: [
      `${counts.all} agents: ${counts.failing} failing, ${counts.healthy} healthy, ${counts.idle} never run`,
      ...rows.filter((r) => r.health === "failing").slice(0, 4).map((r) => `${r.agent.name}'s last run failed`),
    ],
    suggestions: counts.failing
      ? ["Why did my last run fail?", "Create an agent that triages GitHub issues"]
      : ["Create an agent that triages GitHub issues"],
    explain: rows
      .filter((r) => r.health === "failing" && r.last)
      .slice(0, 5)
      .map((r) => ({ id: r.last!.id, label: `${r.agent.name}: last run failed`, sub: r.last!.error?.message, request: { kind: "run" as const, runId: r.last!.id } })),
  });

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.deleteAgent(confirmDelete.name);
      setAgents((prev) => prev.filter((a) => a.id !== confirmDelete.id));
      if (getLastAgent() === confirmDelete.name) clearLastAgent();
      toast.success(`Deleted ${confirmDelete.name}`);
      setConfirmDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t delete the agent");
    } finally {
      setDeleting(false);
    }
  };

  const columns: Column<Row>[] = [
    {
      key: "name",
      header: "Agent",
      sortable: true,
      sortFn: (a, b) => a.agent.name.localeCompare(b.agent.name),
      render: (r) => (
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-[19px] items-center"><HealthDot health={r.health} /></span>
          <div className="min-w-0">
            <p className="truncate font-mono text-[13px] font-medium text-fg">{r.agent.name}</p>
            {r.agent.description && <p className="density-detail hidden max-w-[60ch] truncate text-[12px] text-fg-3 sm:block">{r.agent.description}</p>}
            <p className="mt-0.5 truncate text-[12px] text-fg-3 sm:hidden">
              {r.last ? `${statusWord(r.last.status)} ${shortAgo(ts(r.last.createdAt))}` : "Never run"}
              {r.runs24 ? `, ${r.runs24} today` : ""}
            </p>
          </div>
        </div>
      ),
    },
    {
      key: "last",
      header: "Last run",
      hideOnMobile: true,
      sortable: true,
      sortFn: (a, b) => (ts(a.last?.createdAt) || 0) - (ts(b.last?.createdAt) || 0),
      className: "whitespace-nowrap",
      render: (r) =>
        r.last ? (
          <span className={clsx("text-[12.5px]", r.last.status === "failed" ? "text-bad" : "text-fg-2")}>
            {statusWord(r.last.status)}{" "}
            <span className="text-fg-3">{formatDistanceToNowStrict(ts(r.last.createdAt), { addSuffix: true })}</span>
          </span>
        ) : (
          <span className="text-[12.5px] text-fg-3">Never run</span>
        ),
    },
    {
      key: "runs24",
      header: "Runs (24h)",
      align: "right",
      hideOnMobile: true,
      sortable: true,
      sortFn: (a, b) => a.runs24 - b.runs24,
      render: (r) => <span className="num text-fg-2">{r.runs24}</span>,
    },
    {
      key: "success",
      header: "Success (24h)",
      align: "right",
      className: "whitespace-nowrap",
      sortable: true,
      sortFn: (a, b) => (a.success24 ?? -1) - (b.success24 ?? -1),
      render: (r) =>
        r.success24 === null ? (
          <span className="text-fg-3">—</span>
        ) : (
          <span className={clsx("num", r.success24 < 90 ? "text-bad" : "text-fg-2")}>{r.success24}%</span>
        ),
    },
  ];

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-6 text-center" role="alert">
        <AlertCircle className="h-5 w-5 text-bad" aria-hidden />
        <h2 className="mt-3 text-[15px] font-semibold text-fg">Couldn’t load agents</h2>
        <p className="mt-1 max-w-sm text-[13px] text-fg-3">{error.message}. Check that the control-plane API is reachable.</p>
        <Button size="sm" variant="secondary" className="mt-4" icon={<RefreshCw className="h-3 w-3" />} onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Agents"
        badge={loading ? undefined : <CountBadge count={agents.length} />}
        description="Every agent in this workspace, with how its runs went today. Open one to design, test, evaluate and ship it."
        action={
          <RoleGate cap="agents:write">
            <LinkButton href="/agents/create" variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>
              New agent
            </LinkButton>
          </RoleGate>
        }
      />

      <div className="mx-auto w-full max-w-[1200px] space-y-3 px-4 pb-8 pt-4 md:px-8">
        <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
          <div role="radiogroup" aria-label="Filter by health" className="flex gap-0.5 overflow-x-auto rounded-lg border border-line bg-panel p-0.5">
            {(["all", "failing", "healthy", "idle"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "focus-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] transition-colors",
                  filter === f ? "bg-hover font-medium text-fg" : "text-fg-3 hover:text-fg",
                )}
              >
                {f === "failing" && counts.failing > 0 && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-bad" />}
                {FILTER_LABEL[f]}
                {!loading && <span className="num text-fg-3">{counts[f]}</span>}
              </button>
            ))}
          </div>
          <label className="relative flex-1 sm:max-w-[320px] sm:ml-auto">
            <span className="sr-only">Search agents</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-3" aria-hidden />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents"
              className="h-8 w-full rounded-lg border border-line bg-panel pl-8 pr-8 text-[13px] text-fg placeholder:text-fg-3"
            />
            <Kbd className="absolute right-2 top-1/2 -translate-y-1/2">/</Kbd>
          </label>
        </div>

        <DataTable<Row>
          label="Agents"
          loading={loading || runsLoading}
          rows={visible}
          rowKey={(r) => r.agent.id}
          pageSize={25}
          defaultSort={{ key: "last", dir: "desc" }}
          onRowClick={(r) => router.push(`/agents/${encodeURIComponent(r.agent.name)}`)}
          columns={columns}
          rowActions={[
            { label: "Test", icon: MessageSquare, onClick: (r) => router.push(`/agents/${encodeURIComponent(r.agent.name)}?tab=test`) },
            ...(canWrite ? [{ label: "Delete", icon: Trash2, variant: "danger" as const, onClick: (r: Row) => setConfirmDelete(r.agent) }] : []),
          ]}
          emptyIcon={Bot}
          emptyTitle={agents.length === 0 ? "No agents yet" : "No agents match"}
          emptyDescription={
            agents.length === 0
              ? "Describe a job in plain words and PAL designs the agent, tests your key and runs it once."
              : "Try another filter or search."
          }
          emptyAction={
            agents.length === 0 ? (
              <RoleGate cap="agents:write">
                <LinkButton href="/onboarding" variant="primary">Start guided setup</LinkButton>
              </RoleGate>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => { setFilter("all"); setSearch(""); }}>Clear filters</Button>
            )
          }
        />
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        title={`Delete ${confirmDelete?.name ?? "agent"}?`}
        description="This removes the agent and its versions. Past runs stay in history. This can’t be undone."
        confirmLabel="Delete agent"
        tone="danger"
        confirming={deleting}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void doDelete()}
      />
    </div>
  );
}

/** "2m ago", "3h ago", "5d ago" — short enough to keep phone rows on one line. */
function shortAgo(t: number): string {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function statusWord(s: Run["status"]): string {
  return { queued: "Queued", running: "Running", paused: "Paused", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" }[s] ?? s;
}

function HealthDot({ health }: { health: Health }) {
  return (
    <span
      role="img"
      aria-label={health === "failing" ? "Failing" : health === "healthy" ? "Healthy" : "Never run"}
      className={clsx(
        "h-2 w-2 shrink-0 rounded-full",
        health === "failing" && "bg-bad",
        health === "healthy" && "bg-ok",
        health === "idle" && "border border-line-strong",
      )}
    />
  );
}
