"use client";

// Sandbox detail (v3). Real endpoints only:
//   GET  /v1/runtime/vms/{id}                     state, spec (secrets redacted), audit events
//   GET  /v1/runtime/vms/{id}/logs                SSE from the harness
//   GET  /v1/runtime/vms/{id}/files[/content]     browse /workspace (runtime:read, running VMs)
//   POST /v1/runtime/vms/{id}/{pause,resume,fork} · DELETE /v1/runtime/vms/{id}   (owner/admin)
// Buttons follow the role and the VM's state, but the server decides: a 402/403/409
// is shown with its reason, never hidden. Not offered here: exec and file writes
// (runtime:admin endpoints with no dashboard UI yet; use `pal vm exec`).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { formatDistanceToNowStrict } from "date-fns";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, File as FileIcon, Folder, GitFork, Pause, Play, StopCircle } from "lucide-react";
import { Button } from "@/components/button";
import { ConfirmModal, Modal, ModalField } from "@/components/modal";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/toast";
import { useCan } from "@/components/role-gate";
import { runtimeApi, UnauthorizedError } from "@/lib/runtime-api";
import {
  autoSuspends, fmtBytes, formatLogFrame, isDir, joinPath, lifecycleMessage, logRetryDelay, parentPath, pushLog,
  runtimeFailure, shouldRetryLogs, validateForkCount, vmActions, type FileEntry,
} from "@/lib/sandbox";
import { VmState } from "../vm-state";

const INPUT = "focus-ring w-full rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px] text-fg placeholder:text-fg-3";

interface ForkResult {
  sourceVmId: string;
  snapshotId: string;
  forks: Array<{ vmId: string; state: string; error?: string }>;
}

interface VmDetail {
  vm: {
    vmId: string;
    state: string;
    stateReason?: string | null;
    node: string | null;
    az: string | null;
    region?: string | null;
    isolationClass: string;
    spec: Record<string, unknown> | null;
    createdAt: string;
    terminatedAt?: string | null;
    lastHeartbeatAt?: string | null;
    snapshotId?: string | null;
    parentVmId?: string | null;
  };
  events: Array<{ id: number; action: string; attrs: Record<string, unknown>; at: string }>;
}

type TabKey = "logs" | "files" | "details";
const TABS: { key: TabKey; label: string }[] = [
  { key: "logs", label: "Logs" },
  { key: "files", label: "Files" },
  { key: "details", label: "Details" },
];

export default function SandboxDetailPage() {
  const params = useParams<{ vmId: string }>();
  const router = useRouter();
  const toast = useToast();
  const canAdmin = useCan("runtime:admin");
  const canRead = useCan("runtime:read");
  const vmId = params?.vmId ?? "";
  const [detail, setDetail] = useState<VmDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [tab, setTab] = useState<TabKey>("logs");
  const [busy, setBusy] = useState<"pause" | "resume" | "fork" | "terminate" | null>(null);
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkCount, setForkCount] = useState("1");
  const [forkResult, setForkResult] = useState<ForkResult | null>(null);

  const load = useCallback(async () => {
    if (!vmId) return;
    try {
      const d = await runtimeApi.get<VmDetail>(`/v1/runtime/vms/${encodeURIComponent(vmId)}`);
      setDetail(d);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) return;
      setError(runtimeFailure(err));
    }
  }, [vmId]);

  useEffect(() => {
    if (!canRead) return;
    setDetail(null); // moving between sandboxes must not show the previous one's data
    setError(null);
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load, canRead]);

  const act = async (verb: "pause" | "resume", label: string) => {
    setBusy(verb);
    try {
      await runtimeApi.post(`/v1/runtime/vms/${encodeURIComponent(vmId)}/${verb}`);
      toast.success(`${label} done`);
      await load();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleMessage(label, err));
    } finally {
      setBusy(null);
    }
  };

  const terminate = async () => {
    setBusy("terminate");
    try {
      await runtimeApi.del(`/v1/runtime/vms/${encodeURIComponent(vmId)}`);
      toast.success("Termination requested");
      setTerminateOpen(false);
      await load();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleMessage("Terminate", err));
    } finally {
      setBusy(null);
    }
  };

  const forkN = validateForkCount(forkCount);
  const fork = async () => {
    if (forkN === null) return;
    setBusy("fork");
    try {
      const r = await runtimeApi.post<ForkResult>(`/v1/runtime/vms/${encodeURIComponent(vmId)}/fork`, { count: forkN });
      setForkResult(r);
      const failed = r.forks.filter((f) => f.error);
      if (failed.length === 0) toast.success(`Forked ${r.forks.length} sandbox${r.forks.length === 1 ? "" : "es"}`);
      else toast.warning(`Forked ${r.forks.length - failed.length} of ${r.forks.length}; first error: ${failed[0].error}`);
      await load();
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) toast.error(lifecycleMessage("Fork", err));
    } finally {
      setBusy(null);
    }
  };

  if (!canRead) {
    return <div className="p-6 md:p-8"><EmptyState title="Your role can't view sandboxes" description="Sandboxes are visible to owners, admins and members." /></div>;
  }
  if (error && !detail) {
    return (
      <div className="p-6 md:p-8">
        <EmptyState
          icon={AlertTriangle}
          title={error.status === 404 ? "Sandbox not found" : "Couldn't load this sandbox"}
          description={error.status === 404 ? "It doesn't exist in this workspace." : error.message}
          actionLabel={error.status === 404 ? "All sandboxes" : "Retry"}
          {...(error.status === 404 ? { actionHref: "/runtime" } : { onAction: () => void load() })}
        />
      </div>
    );
  }
  if (!detail) {
    return <div className="space-y-4 p-6 md:p-8"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64 w-full" /></div>;
  }

  const v = detail.vm;
  const can = vmActions(v.state);
  const adminHint = canAdmin ? undefined : "Needs an owner or admin";

  return (
    <div>
      <PageHeader
        title={v.vmId}
        badge={<VmState state={v.state} />}
        description={`${v.node ? `on ${v.node} · ` : ""}${v.isolationClass || "unknown isolation"} · created ${formatDistanceToNowStrict(new Date(v.createdAt), { addSuffix: true })}`}
        secondaryAction={
          <Button variant="ghost" size="sm" icon={<ArrowLeft className="h-3.5 w-3.5" />} onClick={() => router.push("/runtime")}>
            Sandboxes
          </Button>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            {can.pause && <Button variant="secondary" size="sm" icon={<Pause className="h-3.5 w-3.5" />} loading={busy === "pause"} disabled={!canAdmin || busy !== null} title={adminHint} onClick={() => act("pause", "Pause")}>Pause</Button>}
            {can.resume && <Button variant="secondary" size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={busy === "resume"} disabled={!canAdmin || busy !== null} title={adminHint} onClick={() => act("resume", "Resume")}>Resume</Button>}
            {can.fork && <Button variant="secondary" size="sm" icon={<GitFork className="h-3.5 w-3.5" />} disabled={!canAdmin || busy !== null} title={adminHint} onClick={() => { setForkResult(null); setForkOpen(true); }}>Fork</Button>}
            {can.terminate && <Button variant="danger" size="sm" icon={<StopCircle className="h-3.5 w-3.5" />} disabled={!canAdmin || busy !== null} title={adminHint} onClick={() => setTerminateOpen(true)}>Terminate</Button>}
          </div>
        }
      />

      <div className="space-y-4 p-6 md:p-8">
        {error && (
          <p role="alert" className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            Couldn&apos;t refresh ({error.message}). Showing the last successful load.
          </p>
        )}
        {v.state === "failed" && v.stateReason && (
          <p role="alert" className="rounded-lg border border-line bg-bad-soft px-3 py-2 text-[13px] text-bad">Failed: {v.stateReason}</p>
        )}

        <div role="tablist" aria-label="Sandbox sections" className="flex gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                "focus-ring -mb-px border-b-2 px-3 py-2 text-[13px] font-medium",
                tab === t.key ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "logs" && <LogsPanel vmId={v.vmId} ended={v.state === "terminated" || v.state === "failed"} />}
        {tab === "files" && <FilesPanel vmId={v.vmId} state={v.state} spec={v.spec} />}
        {tab === "details" && <DetailsPanel detail={detail} />}
      </div>

      <ConfirmModal
        open={terminateOpen}
        title={`Terminate ${v.vmId}?`}
        description="This drains the sandbox and releases its quota slot. It can't be resumed."
        confirmLabel="Terminate"
        tone="danger"
        confirming={busy === "terminate"}
        onCancel={() => setTerminateOpen(false)}
        onConfirm={terminate}
      />

      <Modal
        open={forkOpen}
        onClose={() => setForkOpen(false)}
        title={`Fork ${v.vmId}`}
        description="Snapshot this sandbox and start copies from the snapshot. Each copy counts against your sandbox quota."
        size="sm"
        footer={
          forkResult ? (
            <Button size="sm" onClick={() => setForkOpen(false)}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => setForkOpen(false)}>Cancel</Button>
              <Button size="sm" loading={busy === "fork"} disabled={forkN === null} onClick={fork}>Fork</Button>
            </>
          )
        }
      >
        {forkResult ? (
          <ul className="space-y-1.5 text-[13px]">
            {forkResult.forks.map((f) => (
              <li key={f.vmId} className="flex items-baseline justify-between gap-3">
                <Link href={`/runtime/${encodeURIComponent(f.vmId)}`} className="min-w-0 truncate font-mono text-accent hover:underline">{f.vmId}</Link>
                <span className={f.error ? "text-bad" : "text-fg-3"}>{f.error ?? f.state}</span>
              </li>
            ))}
          </ul>
        ) : (
          <ModalField label="Number of forks" hint="Whole number, at least 1. The server enforces the maximum and says what it is.">
            <input aria-label="Number of forks" type="number" min={1} step={1} value={forkCount} onChange={(e) => setForkCount(e.target.value)} className={INPUT} />
          </ModalField>
        )}
      </Modal>
    </div>
  );
}

// ── Logs ────────────────────────────────────────────────────────────────────

function LogsPanel({ vmId, ended }: { vmId: string; ended: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const [conn, setConn] = useState<"connecting" | "open" | "retrying" | "closed" | "unavailable">("connecting");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const open = () => {
      setConn("connecting");
      setLines([]); // a reconnect replays from the start; don't duplicate
      let first = true;
      runtimeApi
        .streamSSE(`/v1/runtime/vms/${encodeURIComponent(vmId)}/logs?follow=1`, (d) => {
          if (first) { first = false; attempt = 0; setConn("open"); }
          setLines((prev) => pushLog(prev, formatLogFrame(d)));
        }, ctl.signal)
        .then(() => { if (!ctl.signal.aborted) setConn("closed"); })
        .catch((e) => {
          if (e instanceof UnauthorizedError || ctl.signal.aborted) return;
          if (!shouldRetryLogs(e)) { setConn("unavailable"); return; }
          setConn("retrying");
          retry = setTimeout(open, logRetryDelay(attempt++));
        });
    };
    open();
    return () => { ctl.abort(); clearTimeout(retry); };
  }, [vmId]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  const status = conn === "open" ? "streaming" : conn === "closed" ? (ended ? "stream ended (sandbox has ended)" : "stream closed by the server") : conn === "unavailable" ? "stream unavailable (the server refused it; reload to retry)" : conn === "retrying" ? "disconnected, retrying with backoff" : "connecting";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[12px] text-fg-3">
        <span role="status">{status}</span>
        <span className="num">{lines.length} line{lines.length === 1 ? "" : "s"} (newest 500 kept)</span>
      </div>
      <div ref={box} tabIndex={0} aria-label="Sandbox logs" className="h-[420px] overflow-y-auto rounded-[12px] border border-line bg-canvas p-3 font-mono text-[12px] leading-relaxed text-fg-2">
        {lines.length === 0 ? (
          <p className="text-fg-3">No log lines yet.</p>
        ) : (
          lines.map((l, i) => <div key={i} className="whitespace-pre-wrap break-words">{l}</div>)
        )}
      </div>
    </div>
  );
}

// ── Files ───────────────────────────────────────────────────────────────────

interface Listing { path: string; entries: FileEntry[]; truncated: boolean }

function FilesPanel({ vmId, state, spec }: { vmId: string; state: string; spec: Record<string, unknown> | null }) {
  const [dir, setDir] = useState(".");
  const [listing, setListing] = useState<Listing | null>(null);
  const [file, setFile] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const running = state === "running";

  useEffect(() => {
    if (!running) return;
    let live = true;
    setListing(null); // never join a new directory with the previous directory's names
    setLoading(true);
    setError(null);
    setFile(null);
    runtimeApi
      .get<Listing>(`/v1/runtime/vms/${encodeURIComponent(vmId)}/files?path=${encodeURIComponent(dir)}`)
      .then((l) => live && setListing({ ...l, entries: l.entries ?? [] }))
      .catch((e) => live && !(e instanceof UnauthorizedError) && setError(runtimeFailure(e).message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [vmId, dir, running]);

  const openSeq = useRef(0);
  const open = async (path: string) => {
    const mine = ++openSeq.current; // only the latest click may set the preview
    setError(null);
    try {
      const r = await runtimeApi.getText(`/v1/runtime/vms/${encodeURIComponent(vmId)}/files/content?path=${encodeURIComponent(path)}`);
      if (mine === openSeq.current) setFile({ path, ...r });
    } catch (e) {
      if (mine === openSeq.current && !(e instanceof UnauthorizedError)) setError(runtimeFailure(e).message);
    }
  };
  useEffect(() => { openSeq.current++; }, [dir]); // a pending read for another directory is stale

  if (!running) {
    return <EmptyState size="compact" title="Files are available while the sandbox is running" description={`This sandbox is ${state}. Resume it (or start a new one) to browse /workspace.`} />;
  }
  const up = parentPath(dir);
  return (
    <div className="space-y-3">
      {autoSuspends(spec) && (
        <p className="rounded-lg border border-line bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          This sandbox auto-suspends when idle. Browsing files resumes it if it was suspended, which counts against your sandbox quota.
        </p>
      )}
      <p className="flex items-center gap-2 text-[12.5px] text-fg-3">
        <span>/workspace/{dir === "." ? "" : dir}</span>
        {up !== null && <Button variant="ghost" size="sm" onClick={() => setDir(up)}>Up</Button>}
      </p>
      {error && <p role="alert" className="rounded-lg border border-line bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{error}</p>}
      {loading && !listing ? (
        <Skeleton className="h-32 w-full" />
      ) : listing && listing.entries.length === 0 ? (
        <EmptyState size="compact" title="Empty directory" description="Nothing in this folder." />
      ) : (
        listing && (
          <ul aria-label="Files" className="divide-y divide-line rounded-[12px] border border-line bg-panel">
            {listing.entries.map((e) => (
              <li key={e.name}>
                <button
                  type="button"
                  disabled={e.type !== "dir" && e.type !== "file"}
                  onClick={() => (isDir(e) ? setDir(joinPath(dir, e.name)) : void open(joinPath(dir, e.name)))}
                  className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-fg-2 hover:bg-raised disabled:cursor-default disabled:hover:bg-transparent"
                >
                  {isDir(e) ? <Folder className="h-3.5 w-3.5 text-fg-3" aria-hidden /> : <FileIcon className="h-3.5 w-3.5 text-fg-3" aria-hidden />}
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                  <span className="num text-[12px] text-fg-3">{e.type === "file" ? fmtBytes(e.size) : e.type}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
      {listing?.truncated && <p className="text-[12px] text-fg-3">The listing was cut at the harness limit; not every entry is shown.</p>}
      {file && (
        <div className="space-y-1.5">
          <p className="font-mono text-[12px] text-fg-3">{file.path}</p>
          <pre aria-label="File content" className="max-h-[360px] overflow-auto rounded-[12px] border border-line bg-canvas p-3 font-mono text-[12px] text-fg-2">{file.text}</pre>
          {file.truncated && <p className="text-[12px] text-fg-3">Showing the first 1 MiB; the file is larger.</p>}
        </div>
      )}
    </div>
  );
}

// ── Details ─────────────────────────────────────────────────────────────────

function DetailsPanel({ detail }: { detail: VmDetail }) {
  const v = detail.vm;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="min-w-0 space-y-4">
        <dl className="space-y-1.5 rounded-[12px] border border-line bg-panel p-4 text-[13px]">
          {([
            ["State", v.state],
            ["Isolation", v.isolationClass || "—"],
            ["Node", [v.node, v.az, v.region].filter(Boolean).join(" · ") || "—"],
            ["Last heartbeat", v.lastHeartbeatAt ? `${formatDistanceToNowStrict(new Date(v.lastHeartbeatAt))} ago` : "—"],
            ["Snapshot", v.snapshotId ?? "—"],
          ] as const).map(([k, val]) => (
            <div key={k} className="flex justify-between gap-3"><dt className="text-fg-3">{k}</dt><dd className="min-w-0 break-all text-right font-mono text-fg-2">{val}</dd></div>
          ))}
          {v.parentVmId && (
            <div className="flex justify-between gap-3">
              <dt className="text-fg-3">Forked from</dt>
              <dd className="min-w-0 break-all text-right font-mono"><Link href={`/runtime/${encodeURIComponent(v.parentVmId)}`} className="text-accent hover:underline">{v.parentVmId}</Link></dd>
            </div>
          )}
        </dl>
        <div className="rounded-[12px] border border-line bg-panel p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-fg">Spec</h3>
          <p className="mb-2 text-[12px] text-fg-3">Secret values are redacted by the server.</p>
          <pre className="max-h-[320px] overflow-auto rounded-lg bg-canvas p-3 font-mono text-[12px] text-fg-2">{JSON.stringify(v.spec ?? {}, null, 2)}</pre>
        </div>
      </div>
      <div className="min-w-0 rounded-[12px] border border-line bg-panel p-4">
        <h3 className="mb-2 text-[13px] font-semibold text-fg">Audit trail</h3>
        {detail.events.length === 0 ? (
          <p className="text-[12.5px] text-fg-3">No events yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {detail.events.map((e) => (
              <li key={e.id} className="rounded-lg bg-canvas px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-fg">{e.action}</span>
                  <span className="text-fg-3">{formatDistanceToNowStrict(new Date(e.at), { addSuffix: true })}</span>
                </div>
                {Object.keys(e.attrs || {}).length > 0 && <pre className="mt-1 whitespace-pre-wrap break-words text-fg-3">{JSON.stringify(e.attrs)}</pre>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
