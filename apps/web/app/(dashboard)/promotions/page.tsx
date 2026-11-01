"use client";

// Promotions (v3): every agent's pending approvals and the append-only audit
// trail, tenant-wide. Same endpoints and decision flow as the agent's Promote tab.
//   GET /v1/promotions?status=pending_approval  ·  GET /v1/promotions/audit?limit=
//   POST /v1/promotions/{id}/{approve,reject} (human owner/admin only; the server enforces)

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { PageHeader, CountBadge } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { runtimeApi } from "@/lib/runtime-api";
import { cappedNote, parseApiError, type AuditEntry, type Promotion } from "@/lib/promotion";
import { AuditTrail, PendingApprovals } from "../deployments/agent-environments";

const PENDING_CAP = 100; // GET /v1/promotions is LIMIT 100
const AUDIT_LIMIT = 100;

export default function PromotionsPage() {
  const [pending, setPending] = useState<Promotion[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, a] = await Promise.all([
        runtimeApi.get<Promotion[]>("/v1/promotions?status=pending_approval"),
        runtimeApi.get<AuditEntry[]>(`/v1/promotions/audit?limit=${AUDIT_LIMIT}`),
      ]);
      setPending(p ?? []);
      setAudit(a ?? []);
    } catch (err) {
      setError(parseApiError(err).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cap = pending ? cappedNote(pending.length, PENDING_CAP, "pending promotions") : null;

  return (
    <div>
      <PageHeader
        title="Promotions"
        description="Who is shipping what to sandbox, staging and prod, and what is waiting on a human."
        badge={pending && pending.length > 0 ? <CountBadge count={pending.length} /> : undefined}
      />
      <div className="space-y-8 p-6 md:p-8">
        {error ? (
          <EmptyState icon={AlertTriangle} size="compact" title="Couldn't load promotions" description={error} actionLabel="Retry" onAction={() => void load()} />
        ) : pending === null ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div>
              <PendingApprovals pending={pending} agentLabel onChanged={load} />
              {cap && <p className="mt-2 text-[12px] text-fg-3">{cap}</p>}
            </div>
            <AuditTrail rows={audit} agentLabel limit={AUDIT_LIMIT} />
          </>
        )}
      </div>
    </div>
  );
}
