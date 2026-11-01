"use client";

// /personal/docs — Documents.
//
// The personal-docs assistant lives on the bridges: it searches the owner's own
// Mac, owner-only, from self-chat. The dashboard cannot read the bridge's
// configured folders, search files, or read its audit log, so this page does
// not pretend to: it explains the feature and shows the ONE real, server-backed
// thing documents produce — deadlines PAL derived from them
// (GET /v1/immigration/deadlines, off unless PAL_IMMIGRATION_SENTINEL is set).

import { useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, Eye, Folder, Lock, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { parseDeadlines, type Deadlines } from "@/lib/pal-space";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";

const DEFAULT_ROOTS = ["~/Documents", "~/Desktop", "~/Downloads", "iCloud Drive"];

export default function DocumentsPage() {
  const [deadlines, setDeadlines] = useState<Deadlines | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listImmigrationDeadlines()
      .then((raw) => !cancelled && setDeadlines(parseDeadlines(raw)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load deadlines"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">Documents</h2>
        <p className="mt-0.5 max-w-2xl text-[13px] text-fg-3">
          Text yourself things like “find my I-485 receipt” or “send me my latest pay stub”. PAL searches your Mac, reads the file, and answers in your self-chat. It only listens to you, never to your contacts.
        </p>
      </div>

      <section aria-label="Derived deadlines" className="rounded-[12px] border border-line bg-panel">
        <div className="border-b border-line p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <CalendarClock className="h-4 w-4 text-fg-3" aria-hidden /> Deadlines PAL found in your documents
          </h3>
          <p className="mt-0.5 text-xs text-fg-3">Each one cites the document or email it came from. Anything without a source is dropped.</p>
        </div>
        {error ? (
          <p role="alert" className="flex items-center gap-2 p-4 text-xs text-warn">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Couldn&apos;t load deadlines ({error}).
          </p>
        ) : deadlines === null ? (
          <div className="p-4" aria-busy="true"><Skeleton className="h-12 w-full" /></div>
        ) : !deadlines.enabled ? (
          <EmptyState
            icon={Eye}
            size="compact"
            title="Deadline scanning is off"
            description="It is off unless the server sets PAL_IMMIGRATION_SENTINEL. Nothing is scanned while it is off."
          />
        ) : deadlines.items.length === 0 ? (
          <EmptyState icon={CalendarClock} size="compact" title="No deadlines found yet" description="Nothing has been derived from your documents so far." />
        ) : (
          <ul className="divide-y divide-line">
            {deadlines.items.map((d) => (
              <li key={d.id} className="px-4 py-3">
                <p className="text-sm font-medium text-fg">
                  {d.docType || "Document"}{d.who ? ` · ${d.who}` : ""}
                  <span className="ml-2 font-normal text-fg-2">{d.deadline}</span>
                </p>
                {d.basis && <p className="mt-0.5 text-xs text-fg-3">{d.basis}</p>}
                <p className="mt-0.5 text-[11px] text-fg-3">
                  {Math.round(d.confidence * 100)}% confident{d.sources.length > 0 ? ` · from ${d.sources.join(", ")}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Folders" className="rounded-[12px] border border-line bg-panel p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <Folder className="h-4 w-4 text-fg-3" aria-hidden /> Folders it can search
        </h3>
        <p className="mt-1 text-xs text-fg-3">
          The default folders are {DEFAULT_ROOTS.join(", ")}. The live list is set on the bridge by <code className="rounded bg-raised px-1 py-0.5 text-fg-2">PAL_PERSONAL_DOCS_ROOTS</code>, and this page can&apos;t read it, so it isn&apos;t shown or verified here.
        </p>
      </section>

      <section aria-label="Safeguards" className="rounded-[12px] border border-line bg-panel p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <ShieldCheck className="h-4 w-4 text-ok" aria-hidden /> Safeguards
        </h3>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {[
            { icon: Lock, title: "Owner-only", text: "Only messages sent from your own account trigger it. Contacts and group chats cannot, even by quoting you." },
            { icon: ShieldCheck, title: "Path-restricted", text: "Searches and reads stay inside the allowed folders. Path traversal is blocked at the bridge." },
            { icon: Eye, title: "Audit trail on your Mac", text: "Every search, read and send is logged by the bridge on your Mac. The dashboard can't display that log." },
            { icon: AlertTriangle, title: "Snippets only", text: "At most a short snippet of a matching file goes into the model prompt. A whole file only moves when you ask for it, and it comes back to your own self-chat." },
          ].map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-lg bg-raised p-3">
              <p className="flex items-center gap-2 text-xs font-medium text-fg"><Icon className="h-3.5 w-3.5 text-fg-3" aria-hidden /> {title}</p>
              <p className="mt-1 text-xs text-fg-3">{text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
