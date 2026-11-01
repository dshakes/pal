"use client";

import { AgentA2aCard } from "@/components/agent-a2a-card";
import { usePublicUrls } from "@/lib/public-url";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import {
  Play,
  Loader2,
  Save,
  MessageSquare,
  CheckCircle2,
  Mail,
  Trash2,
  ChevronDown,
  ChevronRight,
  Webhook,
  AlertCircle,
  Zap,
  GitCompare,
  ShieldAlert,
  Plug,
  X,
  Brain,
  Paperclip,
  Send,
  Copy,
  Cloud,
  GitBranch,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { AiAssistButton } from "@/components/ai-assist";
import { LinkButton } from "@/components/button";
import { useAgent, useAgentRuns } from "@/lib/hooks";
import { useToast } from "@/components/toast";
import { SecurityTab } from "./security-tab";
import { StatusBadge } from "@/components/status-badge";
import { CostForecastBadge } from "@/components/cost-forecast-badge";
import { ExecutionLog, deduplicateSteps } from "@/components/execution-log";
import { AgentDetailSkeleton } from "@/components/skeleton";
import { formatCost, formatDuration } from "@/lib/format";
import type { Run } from "@/lib/types";
import { type GuardrailConfig, getGuardrailConfig, saveGuardrailConfig, hasActiveGuardrails } from "@/lib/guardrails";
import { AgentMcpSection } from "@/components/agent-mcp-section";
import { type MemoryEntry, getAgentMemory, memoryToContext } from "@/lib/agent-memory";
import { mergeInstructionsAndPrompt } from "@/lib/agent-instructions";
import { ISOLATION_LEVELS, settingsPatch } from "@/lib/agent-settings";
import { type CodeLanguage, runCode, extractCodeBlocks } from "@/lib/code-runner";
import NextLink from "next/link";
import { runtimeApi } from "@/lib/runtime-api";
import { formatDistanceToNowStrict } from "date-fns";
import { Button } from "@/components/button";
import { ConfirmModal } from "@/components/modal";
import { RoleGate, useCan } from "@/components/role-gate";
import { useAgentSurface } from "@/components/agent-surface";
import { resolveTab, type AgentTab } from "@/lib/lifecycle";
import { DebugPanel, EvalsPanel, GatePanel, LifecycleRail, PromotePanel, ReliabilityStrip } from "./lifecycle";
import { DesignPanel } from "./design-panel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid cron expression";
  const [min, hour, , , dow] = parts;
  const days: Record<string, string> = { "1-5": "weekdays", "0,6": "weekends", "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" };
  let desc = "Runs ";
  if (min === "*" && hour === "*") desc += "every minute";
  else if (min === "0" && hour === "*") desc += "every hour";
  else if (min.startsWith("*/")) desc += `every ${min.slice(2)} minutes`;
  else if (hour !== "*") desc += `at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  else desc += `at minute ${min}`;
  if (dow !== "*") desc += ` on ${days[dow] || dow}`;
  return desc;
}

function getAgentSettings(n: string): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(`pal_agent_settings_${n}`) || "{}"); } catch { return {}; }
}

// ---------------------------------------------------------------------------
// Model Select
// ---------------------------------------------------------------------------

function ModelSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={clsx("rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent", className)}>
      <option value="auto">Auto (recommended)</option>
      <optgroup label="Anthropic">
        <option value="reasoning-frontier">Reasoning Frontier -- Claude Opus 4</option>
        <option value="reasoning-large">Reasoning Large -- Claude Sonnet 4</option>
        <option value="reasoning-small">Reasoning Small -- Claude Haiku 4</option>
        <option value="code-large">Code Large -- Claude Sonnet 4</option>
      </optgroup>
      <optgroup label="OpenAI">
        <option value="chat-large">Chat Large -- GPT-4o</option>
        <option value="chat-small">Chat Small -- GPT-4o Mini</option>
      </optgroup>
      <optgroup label="Google">
        <option value="vision-large">Vision Large -- Gemini 2.5 Pro</option>
      </optgroup>
    </select>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-3">{label}</dt>
      <dd className="num text-fg-2">{children}</dd>
    </div>
  );
}

/** Health from the last run, said in words next to the name. */
function AgentHealth({ last }: { last?: Run }) {
  const state = !last ? "idle" : last.status === "failed" ? "bad" : last.status === "running" || last.status === "queued" ? "live" : "ok";
  const label = { idle: "Never run", bad: "Last run failed", live: "Running", ok: "Healthy" }[state];
  return (
    <span className={clsx(
      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium",
      state === "bad" && "bg-bad-soft text-bad",
      state === "ok" && "bg-ok-soft text-ok",
      state === "live" && "bg-accent-soft text-accent",
      state === "idle" && "bg-raised text-fg-3",
    )}>
      <span aria-hidden className={clsx("h-1.5 w-1.5 rounded-full", state === "bad" && "bg-bad", state === "ok" && "bg-ok", state === "live" && "bg-accent", state === "idle" && "bg-fg-3")} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const RUNS_PER_PAGE = 10;
// Shared grid template so the runs list header lines up with its rows.
const RUN_COLS = "grid-cols-[14px_104px_minmax(0,1fr)_72px_64px_120px]";

// Route tabs (link to sub-pages, /agents/[name]/channels etc.). Rendered
// alongside the in-page tabs as a single visual strip. Kept separate so
// we don't try to flip activeTab to a key whose content lives elsewhere.
const routeTabs = [
  { key: "channels", label: "Channels", icon: Plug, suffix: "/channels" as const },
  { key: "workflow", label: "Workflow", icon: GitBranch, suffix: "/editor" as const },
];

// ---------------------------------------------------------------------------
// Chat types & localStorage helpers
// ---------------------------------------------------------------------------

// A single tool invocation surfaced via SSE during a session message.
// Status starts as "started", flips to "completed" on success or "failed"
// on error. result is a truncated JSON string (server caps to 2 KB).
interface ToolCallEvent {
  name: string;
  args: string; // raw JSON
  result?: string;
  error?: string;
  status: "started" | "completed" | "failed";
}
interface ChatMessage { role: "user" | "assistant"; content: string; timestamp: string; toolCalls?: ToolCallEvent[]; }
const CHAT_KEY = (n: string) => `pal_chat_${n}`;
function loadChat(n: string): ChatMessage[] { if (typeof window === "undefined") return []; try { return JSON.parse(localStorage.getItem(CHAT_KEY(n)) || "[]"); } catch { return []; } }
function saveChat(n: string, msgs: ChatMessage[]) { if (typeof window === "undefined") return; localStorage.setItem(CHAT_KEY(n), JSON.stringify(msgs)); }

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function AgentDetailPage() {
  const { apiBase } = usePublicUrls();
  // UX gating only (lib/rbac-matrix.ts) - the server stays authoritative.
  const canWrite = useCan("agents:write");
  const canRun = useCan("runs:execute");
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const name = params.name as string;

  const { agent, loading: agentLoading, error: agentError, refresh: refreshAgent } = useAgent(name);
  const { runs: agentRuns, loading: runsLoading, refresh: refreshRuns } = useAgentRuns(name);

  // Setup-gate status. ready=false means the agent has required connectors
  // or surfaces that aren't connected — we banner the page and disable Run.
  // Templated agents store their requirements in labels JSONB; non-template
  // agents return ready=true with empty requirements, so this is a no-op
  // for the common case.
  type SetupStatus = Awaited<ReturnType<typeof api.getAgentSetupStatus>>;
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getAgentSetupStatus(name).then(
      (s) => { if (!cancelled) setSetupStatus(s); },
      () => { /* non-fatal — page still works */ },
    );
    return () => { cancelled = true; };
  }, [name]);
  const setupReady = setupStatus?.ready ?? true; // optimistic until known
  const missingCount =
    (setupStatus?.missing.connectors.length ?? 0) +
    (setupStatus?.missing.surfaces.length ?? 0);

  const [activeTab, setActiveTab] = useState<AgentTab>(() => resolveTab(searchParams.get("tab")));
  // Keep ?tab= in the URL so a tab is linkable and survives reload.
  const selectTab = useCallback((t: AgentTab) => {
    setActiveTab(t);
    const q = new URLSearchParams(window.location.search);
    q.set("tab", t);
    router.replace(`?${q.toString()}`, { scroll: false });
  }, [router]);

  // Where the frozen versions are live (sandbox / staging / prod), for the header.
  const [envSummary, setEnvSummary] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    runtimeApi.get<{ environments?: Array<{ env: string; version: string; status: string; canaryPct?: number }> }>(`/v1/agents/${encodeURIComponent(name)}/environments`)
      .then((e) => {
        if (off) return;
        const live = (e.environments ?? []).filter((x) => x.status === "active" || x.status === "canary");
        setEnvSummary(live.length ? live.map((x) => `${x.env} ${x.version}${x.status === "canary" ? ` (canary ${x.canaryPct ?? 0}%)` : ""}`).join(", ") : null);
      })
      .catch(() => { /* no environments yet: header just omits it */ });
    return () => { off = true; };
  }, [name]);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState("");
  // Test state
  const [testModel] = useState("auto");
  const [testRunning, setTestRunning] = useState(false);

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [settingsCron, setSettingsCron] = useState("");
  const [deliveryEmailEnabled, setDeliveryEmailEnabled] = useState(false);
  const [deliveryEmail, setDeliveryEmail] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [nextFireAt, setNextFireAt] = useState<string | null>(null);

  // Settings
  const [settingsModel, setSettingsModel] = useState("auto");
  const [settingsIsolation, setSettingsIsolation] = useState("");
  const [settingsTimeout, setSettingsTimeout] = useState("5m");
  const [settingsMaxTokens, setSettingsMaxTokens] = useState(100000);
  const [settingsMaxCost, setSettingsMaxCost] = useState(1.0);
  const [settingsRetention, setSettingsRetention] = useState("90d");
  const [settingsEncrypt, setSettingsEncrypt] = useState(false);
  const [settingsAuditLog, setSettingsAuditLog] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Guardrails
  const [guardrails, setGuardrails] = useState<GuardrailConfig>({ contentFilter: false, blockPII: false, blockToxic: false, blockedTopics: [], maxResponseLength: 0 });
  const [blockedTopicsInput, setBlockedTopicsInput] = useState("");

  // Instructions (separated from system prompt)
  const [instructions, setInstructions] = useState("");

  // Agent Memory
  const [memoryEntries, setMemoryEntries] = useState<MemoryEntry[]>([]);

  // Chat (Feature 1) — now session-backed
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatStreaming, setChatStreaming] = useState(false);
  // Accumulates token deltas for in-progress streaming turns.
  const [streamingDraft, setStreamingDraft] = useState<string | null>(null);
  const streamingDraftRef = useRef<string>("");
  const [chatIncludeEmails, setChatIncludeEmails] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [chatFiles, setChatFiles] = useState<Array<{ name: string; content: string }>>([]);

  // Session state (Gap 1: Session Abstraction)
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [sessionConnected, setSessionConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Gap 2: Managed environment settings (stored in localStorage)
  const [envRuntime, setEnvRuntime] = useState("node22");
  const [envMemory, setEnvMemory] = useState("512mb");
  const [envTimeout, setEnvTimeout] = useState("5m");
  const [envNetwork, setEnvNetwork] = useState("allow-all");
  const [envPackages, setEnvPackages] = useState("");

  // Code Sandbox (Feature 3)
  const [codeBlockResults, setCodeBlockResults] = useState<Record<number, { output: string; error: boolean }>>({});



  // Cloud Deploy (Gap 5)
  const [cloudDeployStatus, setCloudDeployStatus] = useState<string>("not_deployed");
  const [cloudDeployUrl, setCloudDeployUrl] = useState<string>("");
  const [deploying, setDeploying] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Run polling (Feature 5)
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Run comparison
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<[string | null, string | null]>([null, null]);

  // Runs tab
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runsPage, setRunsPage] = useState(0);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);

  // The server's agent is the source of truth for prompt and model.
  useEffect(() => {
    if (!agent) return;
    setSystemPrompt(agent.systemPrompt ?? "");
    setSettingsModel(agent.model || "auto");
  }, [agent]);

  // Load saved state
  useEffect(() => {
    const s = getAgentSettings(name);
    if (s.timeout) setSettingsTimeout(s.timeout as string);
    if (s.maxTokens) setSettingsMaxTokens(s.maxTokens as number);
    if (s.maxCostUsd) setSettingsMaxCost(s.maxCostUsd as number);
    if (s.cron) setSettingsCron(s.cron as string);
    // Load guardrails
    setGuardrails(getGuardrailConfig(name));
    setBlockedTopicsInput(getGuardrailConfig(name).blockedTopics.join(", "));
    // Load memory
    setMemoryEntries(getAgentMemory(name));
    // Load chat history
    setChatMessages(loadChat(name));
    // Load managed environment settings (Gap 2)
    try {
      const envSettings = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}");
      if (envSettings.runtime) setEnvRuntime(envSettings.runtime);
      if (envSettings.memory) setEnvMemory(envSettings.memory);
      if (envSettings.timeout) setEnvTimeout(envSettings.timeout);
      if (envSettings.network) setEnvNetwork(envSettings.network);
      if (envSettings.packages) setEnvPackages(envSettings.packages);
    } catch { /* */ }
    // Load cloud deploy status (Gap 5)
    api.getCloudDeployment(name).then((d) => {
      setCloudDeployStatus(d.status);
      if (d.url) setCloudDeployUrl(d.url);
    }).catch(() => {
      try {
        const deployConfig = JSON.parse(localStorage.getItem(`pal_deploy_${name}`) || "{}");
        if (deployConfig.status) setCloudDeployStatus(deployConfig.status);
        if (deployConfig.url) setCloudDeployUrl(deployConfig.url);
      } catch { /* */ }
    });
    // Restore session ID from localStorage (Gap 1)
    try {
      const savedSessionId = localStorage.getItem(`pal_session_${name}`);
      if (savedSessionId) {
        setSessionId(savedSessionId);
        // Verify the session is still valid
        api.getSession(savedSessionId).then((s) => {
          if (s.status === "active" || s.status === "processing") {
            setChatMessages(s.messages.map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
              timestamp: m.timestamp,
              toolCalls: m.toolCalls?.map((tc) => ({
                name: tc.name,
                args: tc.args,
                result: tc.result,
                error: tc.error,
                status: (tc.status === "completed" || tc.status === "failed" || tc.status === "started") ? tc.status : "completed",
              })),
            })));
            setSessionConnected(true);
          } else {
            // Session is stopped/deleted, clear it
            localStorage.removeItem(`pal_session_${name}`);
            setSessionId(null);
          }
        }).catch(() => {
          // API unavailable, fall back to localStorage chat
          setChatMessages(loadChat(name));
          setSessionConnected(false);
        });
      }
    } catch { /* */ }
    api.listSchedules().then((sched) => {
      const m = sched.find((sc) => sc.agentName === name);
      if (m) { setSettingsCron(m.cronExpr); setScheduleEnabled(m.enabled); if (m.nextFireAt) setNextFireAt(m.nextFireAt); if (m.deliveryEmail) { setDeliveryEmailEnabled(true); setDeliveryEmail(m.deliveryEmail); } }
    }).catch(() => {});
  }, [name]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages, chatStreaming]);

  // Gap 1: Connect to session SSE when sessionId is set
  // Tool calls accumulated since the last agent.message — gets attached
  // to the next assistant message so each chat bubble can render its own
  // "Used GitHub" / "Used Linear" indicators inline.
  const pendingToolCallsRef = useRef<ToolCallEvent[]>([]);
  useEffect(() => {
    if (!sessionId || !sessionConnected) return;
    const es = api.connectSessionEvents(sessionId);
    eventSourceRef.current = es;
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "agent.message") {
          const assistantMsg: ChatMessage = {
            role: "assistant",
            content: data.data?.content || "",
            timestamp: data.data?.timestamp || new Date().toISOString(),
            toolCalls: pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
          };
          pendingToolCallsRef.current = []; // reset for next message
          setChatMessages((prev) => {
            const updated = [...prev, assistantMsg];
            saveChat(name, updated);
            return updated;
          });
          setChatStreaming(false);
          setSessionStatus("idle");
        } else if (data.type === "agent.thinking") {
          setChatStreaming(true);
          setSessionStatus("thinking");
        } else if (data.type === "agent.tool_call_started") {
          // Append placeholder; the matching completed/failed event will
          // mutate this entry by name (best-effort — duplicate names are
          // disambiguated by order of arrival).
          pendingToolCallsRef.current.push({
            name: data.data?.name || "tool",
            args: data.data?.args || "{}",
            status: "started",
          });
          setSessionStatus("thinking");
        } else if (data.type === "agent.tool_call_completed" || data.type === "agent.tool_call_failed") {
          const failed = data.type === "agent.tool_call_failed";
          // Find the most recent "started" entry with this name and mutate.
          for (let i = pendingToolCallsRef.current.length - 1; i >= 0; i--) {
            const tc = pendingToolCallsRef.current[i];
            if (tc.name === data.data?.name && tc.status === "started") {
              tc.status = failed ? "failed" : "completed";
              if (failed) tc.error = data.data?.error;
              else tc.result = data.data?.result;
              break;
            }
          }
        } else if (data.type === "session.status_idle") {
          setChatStreaming(false);
          setSessionStatus("idle");
        } else if (data.type === "session.stopped") {
          setSessionStatus("stopped");
          setChatStreaming(false);
        }
      } catch { /* ignore malformed events */ }
    };
    // Named SSE events for token-level streaming (new protocol).
    // EventSource.onmessage only fires on default (unnamed) events; named
    // events require addEventListener. Unknown event names are silently
    // ignored so old and new servers are both handled.
    es.addEventListener("message_delta", (e) => {
      try {
        const data = JSON.parse(e.data) as { seq?: number; delta?: string };
        if (typeof data.delta === "string") {
          streamingDraftRef.current += data.delta;
          setStreamingDraft(streamingDraftRef.current);
          setChatStreaming(true);
        }
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("message_completed", (e) => {
      try {
        const data = JSON.parse(e.data) as { text?: string };
        const finalText = data.text ?? streamingDraftRef.current;
        const assistantMsg: ChatMessage = {
          role: "assistant",
          content: finalText,
          timestamp: new Date().toISOString(),
          toolCalls: pendingToolCallsRef.current.length > 0 ? [...pendingToolCallsRef.current] : undefined,
        };
        pendingToolCallsRef.current = [];
        streamingDraftRef.current = "";
        setStreamingDraft(null);
        setChatMessages((prev) => {
          const updated = [...prev, assistantMsg];
          saveChat(name, updated);
          return updated;
        });
        setChatStreaming(false);
        setSessionStatus("idle");
      } catch { /* ignore malformed */ }
    });

    es.addEventListener("message_error", (e) => {
      try {
        const data = JSON.parse(e.data) as { error?: string };
        const errMsg: ChatMessage = {
          role: "assistant",
          content: `Error: ${data.error ?? "Stream error"}`,
          timestamp: new Date().toISOString(),
        };
        streamingDraftRef.current = "";
        setStreamingDraft(null);
        setChatMessages((prev) => {
          const updated = [...prev, errMsg];
          saveChat(name, updated);
          return updated;
        });
        setChatStreaming(false);
        setSessionStatus("idle");
      } catch { /* ignore malformed */ }
    });

    es.onerror = () => {
      // SSE connection failed — mark as disconnected but keep session
      setSessionConnected(false);
      es.close();
    };
    return () => {
      es.close();
      eventSourceRef.current = null;
      streamingDraftRef.current = "";
      setStreamingDraft(null);
    };
  }, [sessionId, sessionConnected, name]);

  // Feature 5: Polling for running runs
  useEffect(() => {
    if (!expandedRunId) return;
    const run = agentRuns.find(r => r.id === expandedRunId);
    if (!run || run.status !== "running") { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } return; }
    pollingRef.current = setInterval(async () => {
      try { await refreshRuns(); } catch { /* silent */ }
    }, 2000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [expandedRunId, agentRuns, refreshRuns]);

  const isEmailAgent = useMemo(() => name.toLowerCase().includes("gmail") || name.toLowerCase().includes("email"), [name]);

  // --- Callbacks ---

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try { await api.deleteAgent(name); toast.success(`Agent "${name}" deleted`); router.push("/agents"); } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to delete"); } finally { setDeleting(false); setShowDeleteConfirm(false); }
  }, [name, toast, router]);

  const handleSaveSchedule = useCallback(async () => {
    if (!settingsCron.trim()) { toast.error("Enter a cron expression"); return; }
    setSavingSchedule(true);
    try {
      const result = await api.createSchedule({ agentName: name, cronExpr: settingsCron, deliveryEmail: deliveryEmailEnabled ? deliveryEmail : undefined, enabled: scheduleEnabled });
      if (result.nextFireAt) setNextFireAt(result.nextFireAt);
      toast.success(result.nextFireAt ? `Schedule saved -- next at ${new Date(result.nextFireAt).toLocaleString()}` : "Schedule saved");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Failed to save"); } finally { setSavingSchedule(false); }
  }, [name, settingsCron, deliveryEmailEnabled, deliveryEmail, scheduleEnabled, toast]);

  const handleSaveSettings = useCallback(async () => {
    setSavingSettings(true);
    // The API stores the model and (via the manifest) isolation. Timeout and
    // token/cost limits have no server field yet — say so instead of claiming them.
    try {
      const patch = settingsPatch({ model: agent?.model }, { model: settingsModel, isolation: settingsIsolation });
      if (Object.keys(patch).length === 0) { toast.info("Nothing changed."); return; }
      await api.updateAgent(name, patch);
      await refreshAgent();
      toast.success("Model and isolation saved. Timeout and token/cost limits aren’t stored by the API yet — use Budgets for spend caps.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t save settings");
    } finally { setSavingSettings(false); }
  }, [name, agent?.model, refreshAgent, settingsModel, settingsIsolation, toast]);

  // Guardrails save helper
  const handleSaveGuardrails = useCallback((updated: GuardrailConfig) => {
    setGuardrails(updated);
    saveGuardrailConfig(name, updated);
  }, [name]);

  // Gap 1: Session-backed chat handler with mid-execution steering (Gap 3)
  const handleChatSend = useCallback(async () => {
    const text = chatInput.trim();
    if (!text && chatFiles.length === 0) return;
    // Setup gate: if the agent's template declared required connectors or
    // surfaces and they aren't all connected, divert to the setup page
    // instead of letting the model babble "no connectors provided."
    if (!setupReady) {
      toast.warning("Finish setup first — this agent needs its tools connected.");
      router.push(`/agents/${encodeURIComponent(name)}/setup`);
      return;
    }
    let content = text;
    for (const f of chatFiles) { content += `\n\n[Attached file: ${f.name}]\n<file-content>\n${f.content.slice(0, 5000)}\n</file-content>`; }
    const userMsg: ChatMessage = { role: "user", content, timestamp: new Date().toISOString() };
    const updated = [...chatMessages, userMsg];
    setChatMessages(updated); setChatInput(""); setChatFiles([]);
    saveChat(name, updated);

    // Gap 3: Mid-execution steering — always allow sending, even while streaming.
    // If a session is active, send via session endpoint (which handles steering).
    // Otherwise fall back to direct LLM call.
    if (sessionId && sessionConnected) {
      // Session-backed path: send message via API
      setChatStreaming(true);
      setSessionStatus("thinking");
      try {
        await api.sendSessionMessage(sessionId, content);
        // Response will arrive via SSE (handled in useEffect above)
      } catch {
        // Session API failed — fall back to direct LLM
        console.warn("[pal] Session API unavailable, falling back to direct LLM");
        setSessionConnected(false);
        await fallbackDirectLLM(updated);
      }
    } else {
      // Try to create a session first
      if (!sessionId) {
        try {
          const session = await api.createSession(name);
          setSessionId(session.id);
          setSessionConnected(true);
          localStorage.setItem(`pal_session_${name}`, session.id);
          // Send the message via the new session
          setChatStreaming(true);
          setSessionStatus("thinking");
          await api.sendSessionMessage(session.id, content);
          return;
        } catch {
          // API unavailable — fall through to direct LLM
          console.warn("[pal] Session creation failed, using direct LLM");
        }
      }
      await fallbackDirectLLM(updated);
    }
  }, [chatInput, chatFiles, chatMessages, instructions, systemPrompt, memoryEntries, testModel, name, sessionId, sessionConnected]);

  // Fallback: direct LLM call when session API is unavailable. Passes
  // agentName so the server attaches the tenant's connector tools and
  // runs the same tool-use loop the session API uses — without this, the
  // fallback path lands on plain completions with no tools and the model
  // says "no connectors provided" regardless of what's installed.
  const fallbackDirectLLM = useCallback(async (updated: ChatMessage[]) => {
    setChatStreaming(true);
    const effectivePrompt = mergeInstructionsAndPrompt(instructions, systemPrompt) + memoryToContext(memoryEntries);
    const messages: Array<{ role: string; content: string }> = [];
    if (effectivePrompt.trim()) messages.push({ role: "system", content: effectivePrompt });
    for (const m of updated) messages.push({ role: m.role, content: m.content });
    try {
      const response = await api.complete({ messages, model: testModel, stream: true, temperature: 1.0, maxTokens: 4096, agentName: name });
      if (!response.ok) throw new Error(`API error ${response.status}`);
      let full = "";
      const fallbackToolCalls: ToolCallEvent[] = [];
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.body?.getReader(); if (!reader) throw new Error("No body");
        const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const evt = JSON.parse(line.slice(6).trim());
              if (evt.type === "delta" && evt.content) {
                full += evt.content;
              } else if (evt.type === "tool_call_started") {
                fallbackToolCalls.push({ name: evt.name, args: evt.args ?? "{}", status: "started" });
              } else if (evt.type === "tool_call_completed" || evt.type === "tool_call_failed") {
                for (let i = fallbackToolCalls.length - 1; i >= 0; i--) {
                  if (fallbackToolCalls[i].name === evt.name && fallbackToolCalls[i].status === "started") {
                    fallbackToolCalls[i].status = evt.type === "tool_call_failed" ? "failed" : "completed";
                    if (evt.result) fallbackToolCalls[i].result = evt.result;
                    if (evt.error) fallbackToolCalls[i].error = evt.error;
                    break;
                  }
                }
              }
            } catch { /* malformed event — skip */ }
          }
        }
      } else { const result = await response.json(); full = result.content || JSON.stringify(result, null, 2); }
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: full || "(no response)",
        timestamp: new Date().toISOString(),
        toolCalls: fallbackToolCalls.length > 0 ? fallbackToolCalls : undefined,
      };
      const final = [...updated, assistantMsg]; setChatMessages(final); saveChat(name, final);
    } catch (err) {
      const errMsg: ChatMessage = { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Unknown error"}`, timestamp: new Date().toISOString() };
      const final = [...updated, errMsg]; setChatMessages(final); saveChat(name, final);
    } finally { setChatStreaming(false); }
  }, [instructions, systemPrompt, memoryEntries, testModel, name]);

  // Feature 2: File attachment handler (shared between build test and chat)
  const handleFileAttach = useCallback((setter: (fn: (prev: Array<{ name: string; content: string }>) => Array<{ name: string; content: string }>) => void) => {
    const input = document.createElement("input"); input.type = "file"; input.multiple = true;
    input.accept = ".txt,.csv,.json,.pdf,.md,.py,.js,.ts";
    input.onchange = () => {
      if (!input.files) return;
      Array.from(input.files).forEach(file => {
        const reader = new FileReader();
        reader.onload = () => { setter(prev => [...prev, { name: file.name, content: reader.result as string }]); };
        reader.readAsText(file);
      });
    };
    input.click();
  }, []);

  const handleRunCodeBlock = useCallback(async (idx: number, code: string, language: string) => {
    const lang: CodeLanguage = language === "python" ? "python" : language === "sql" ? "sql" : "javascript";
    const result = await runCode(code, lang);
    setCodeBlockResults(prev => ({ ...prev, [idx]: { output: result.output, error: result.error } }));
  }, []);

  // Agent health stats
  const healthStats = useMemo(() => {
    const total = agentRuns.length;
    const succeeded = agentRuns.filter(r => r.status === "succeeded").length;
    const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;
    const avgCost = total > 0 ? agentRuns.reduce((s, r) => s + r.costUsd, 0) / total : 0;
    const avgDuration = total > 0 ? agentRuns.reduce((s, r) => {
      if (!r.startedAt) return s;
      const end = r.finishedAt ? new Date(r.finishedAt).getTime() : Date.now();
      return s + (end - new Date(r.startedAt).getTime());
    }, 0) / total : 0;
    const lastRun = agentRuns[0] ?? null;
    // Trend: compare last 5 vs previous 5
    const recent5 = agentRuns.slice(0, 5);
    const prev5 = agentRuns.slice(5, 10);
    const recentRate = recent5.length > 0 ? recent5.filter(r => r.status === "succeeded").length / recent5.length : 0;
    const prevRate = prev5.length > 0 ? prev5.filter(r => r.status === "succeeded").length / prev5.length : 0;
    const trend = recent5.length < 2 ? "neutral" : recentRate >= prevRate ? "up" : "down";
    return { total, succeeded, successRate, avgCost, avgDuration, lastRun, trend };
  }, [agentRuns]);

  const succeededRuns = agentRuns.filter((r) => r.status === "succeeded").length;
  const totalCost = agentRuns.reduce((sum, r) => sum + r.costUsd, 0);

  const failedRuns = agentRuns.filter((r) => r.status === "failed");
  useAgentSurface({
    page: `Agent ${name} (${activeTab} tab)`,
    facts: [
      `agent ${name}${agent?.description ? `: ${agent.description}` : ""}`,
      `${agentRuns.length} runs, ${failedRuns.length} failed, ${formatCost(totalCost)} spent`,
      envSummary ? `live in ${envSummary}` : "not promoted to any environment yet",
    ],
    suggestions: failedRuns.length ? ["Why did my last run fail?"] : ["Open runs"],
    explain: failedRuns.slice(0, 5).map((r) => ({ id: r.id, label: `Run ${r.id.slice(0, 8)} failed`, sub: r.error?.message, request: { kind: "run" as const, runId: r.id } })),
  });

  if (agentLoading) return <AgentDetailSkeleton />;
  if (agentError || !agent) return (
    <div className="flex flex-1 items-center justify-center">
      <div className="text-center">
        <p className="text-sm font-medium text-fg-2">Agent not found</p>
        <p className="mt-1 max-w-sm text-xs text-fg-3">
          The agent <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-fg-2">{name}</code> does not exist or may have been deleted.
        </p>
        <button onClick={() => router.push("/agents")} className="mt-3 text-sm text-accent hover:text-accent">Back to Agents</button>
      </div>
    </div>
  );

  const routeLinks = routeTabs.map((t) => ({ label: t.label, href: `/agents/${encodeURIComponent(name)}${t.suffix}` }));
  const last = agentRuns[0];
  const live = agentRuns.filter((r) => r.status === "running" || r.status === "queued").length;

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      {/* Header (v3): who the agent is, how it's doing, and its lifecycle rail. */}
      <div className="shrink-0 px-4 pt-6 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="font-mono text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg">{agent.name}</h1>
              <AgentHealth last={last} />
            </div>
            {agent.description && <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-fg-3">{agent.description}</p>}
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
              <Fact label="Runs">{healthStats.total}{live ? `, ${live} live` : ""}</Fact>
              <Fact label="Success">{healthStats.total ? `${healthStats.successRate}%` : "—"}</Fact>
              <Fact label="Spend">{formatCost(totalCost)}</Fact>
              <Fact label="Last run">{last ? formatDistanceToNowStrict(new Date(last.createdAt), { addSuffix: true }) : "never"}</Fact>
              {envSummary && <Fact label="Live in">{envSummary}</Fact>}
            </dl>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="secondary" size="md" icon={<MessageSquare className="h-3.5 w-3.5" />} onClick={() => selectTab("test")}>
              Test
            </Button>
            <RoleGate cap="agents:write">
              <Button variant="ghost" size="md" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setShowDeleteConfirm(true)} aria-label="Delete agent">
                <span className="hidden sm:inline">Delete</span>
              </Button>
            </RoleGate>
          </div>
        </div>
        <div className="mt-5">
          <LifecycleRail active={activeTab} onSelect={selectTab} routes={routeLinks} />
        </div>
      </div>

      {/* Setup gate banner: template-derived requirements that aren't met yet. */}
      {!setupReady && setupStatus && (
        <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-warn/40 bg-warn-soft px-4 py-3 md:mx-8">
          <p className="text-[13px] text-warn">
            <span className="font-semibold">Setup needed.</span> {missingCount} item{missingCount === 1 ? "" : "s"} left before this agent can run reliably.
          </p>
          <NextLink href={`/agents/${encodeURIComponent(name)}/setup`} className="focus-ring rounded-md border border-warn/40 px-3 py-1 text-[12.5px] font-medium text-warn hover:bg-warn/10">
            Finish setup
          </NextLink>
        </div>
      )}

      <div id="agent-tabpanel" role="tabpanel" aria-labelledby={`agent-tab-${activeTab}`} className="flex-1 px-4 py-6 md:px-8">
        {activeTab === "evals" && <EvalsPanel agentName={name} />}
        {activeTab === "gate" && <GatePanel agentName={name} />}
        {activeTab === "promote" && <PromotePanel agentName={name} />}
        {activeTab === "debug" && <DebugPanel agentName={name} />}

        {/* DESIGN (was Build) */}
        {activeTab === "design" && agent && (
          <DesignPanel agent={agent} onSaved={() => void refreshAgent()} onOpenTab={(t) => selectTab(t)} />
        )}

        {activeTab === "test" && (
          <div className="flex h-[calc(100vh-260px)] flex-col">
            {/* Chat header with session status */}
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-fg-2">Session</h3>
                {sessionConnected ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">
                    <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Connected
                  </span>
                ) : sessionId ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-soft px-2 py-0.5 text-[11px] font-medium text-warn">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" /> Reconnecting...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-line-strong px-2 py-0.5 text-[11px] font-medium text-fg-3">
                    Local mode
                  </span>
                )}
                {sessionStatus === "thinking" && (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-accent">
                    <Brain className="h-3 w-3 animate-pulse" /> Processing...
                  </span>
                )}
                {isEmailAgent && (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-3">
                    <button type="button" role="switch" aria-checked={chatIncludeEmails} onClick={() => setChatIncludeEmails(!chatIncludeEmails)} className={clsx("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors", chatIncludeEmails ? "bg-accent" : "bg-line-strong")}>
                      <span className={clsx("inline-block h-2.5 w-2.5 rounded-full bg-fg transition-transform", chatIncludeEmails ? "translate-x-3.5" : "translate-x-0.5")} />
                    </button>
                    <Mail className="h-3 w-3" /> Include emails
                  </label>
                )}
              </div>
              <div className="flex items-center gap-2">
                {sessionId && (
                  <button onClick={async () => {
                    try { await api.stopSession(sessionId); } catch { /* */ }
                    setSessionId(null); setSessionConnected(false);
                    localStorage.removeItem(`pal_session_${name}`);
                    toast.success("Session ended");
                  }} className="text-[12px] text-fg-3 hover:text-warn">End session</button>
                )}
                <button onClick={() => {
                  setChatMessages([]); saveChat(name, []);
                  if (sessionId) {
                    api.deleteSession(sessionId).catch(() => {});
                    setSessionId(null); setSessionConnected(false);
                    localStorage.removeItem(`pal_session_${name}`);
                  }
                  toast.success("Conversation cleared");
                }} className="text-[12px] text-fg-3 hover:text-bad">Clear conversation</button>
              </div>
            </div>

            {/* Message list */}
            <div className="flex-1 overflow-auto rounded-xl border border-line bg-canvas p-4 space-y-3">
              {chatMessages.length === 0 && !chatStreaming && (
                <div className="flex h-full flex-col items-center justify-center gap-2">
                  <Brain className="h-8 w-8 text-fg-3" />
                  <p className="text-sm text-fg-3">Start a conversation with {name}</p>
                  <p className="text-[11px] text-fg-3">
                    {sessionConnected ? "Session active -- messages are persisted server-side" : "Messages will be sent to the LLM directly"}
                  </p>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={clsx("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={clsx("max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm", msg.role === "user" ? "bg-accent-soft text-fg" : "bg-raised text-fg-2")}>
                    {/* Tool calls executed before this assistant turn. Match
                        the ChatGPT/Claude "used X" indicator — collapsed by
                        default, click to expand the args/result. */}
                    {msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mb-2 space-y-1">
                        {msg.toolCalls.map((tc, ti) => {
                          const [connectorId, action] = tc.name.split("__");
                          return (
                            <details key={ti} className="group rounded-lg border border-line-strong bg-panel">
                              <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[12px] [&::-webkit-details-marker]:hidden">
                                {tc.status === "started" && <Loader2 className="h-3 w-3 animate-spin text-fg-3" />}
                                {tc.status === "completed" && <CheckCircle2 className="h-3 w-3 text-ok" />}
                                {tc.status === "failed" && <AlertCircle className="h-3 w-3 text-bad" />}
                                <span className="text-fg-2">Used</span>
                                <span className="font-medium text-fg">{connectorId}</span>
                                <span className="text-fg-3">·</span>
                                <span className="font-mono text-[11px] text-fg-2">{action}</span>
                              </summary>
                              <div className="border-t border-line px-2.5 py-2 text-[11px] text-fg-3">
                                {tc.args && tc.args !== "{}" && (
                                  <>
                                    <p className="font-medium text-fg-2">Args</p>
                                    <pre className="mt-0.5 overflow-auto whitespace-pre-wrap break-all font-mono text-fg-3">{tc.args}</pre>
                                  </>
                                )}
                                {tc.result && (
                                  <>
                                    <p className="mt-1.5 font-medium text-fg-2">Result</p>
                                    <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-fg-3">{tc.result}</pre>
                                  </>
                                )}
                                {tc.error && (
                                  <>
                                    <p className="mt-1.5 font-medium text-bad">Error</p>
                                    <pre className="mt-0.5 whitespace-pre-wrap font-mono text-bad">{tc.error}</pre>
                                  </>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    )}
                    <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                    {/* Code block run buttons in assistant messages */}
                    {msg.role === "assistant" && extractCodeBlocks(msg.content).map((block, bi) => (
                      <div key={bi} className="mt-2">
                        <button onClick={() => handleRunCodeBlock(i * 100 + bi, block.code, block.language)} className="inline-flex items-center gap-1 rounded bg-raised px-2 py-0.5 text-[11px] text-accent hover:bg-hover">
                          <Play className="h-2.5 w-2.5" /> Run {block.language}
                        </button>
                        {codeBlockResults[i * 100 + bi] && (
                          <pre className={clsx("mt-1 rounded bg-panel p-2 text-[11px]", codeBlockResults[i * 100 + bi].error ? "text-bad" : "text-fg-2")}>{codeBlockResults[i * 100 + bi].output}</pre>
                        )}
                      </div>
                    ))}
                    <p className="mt-1 text-[9px] text-fg-3">{new Date(msg.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
              ))}
              {chatStreaming && (
                <div className="flex justify-start">
                  {streamingDraft ? (
                    // Token-streaming: show partial reply with a blinking cursor.
                    <div className="max-w-[80%] rounded-xl bg-raised px-3.5 py-2.5 text-sm text-fg-2">
                      <div className="whitespace-pre-wrap leading-relaxed">
                        {streamingDraft}
                        <span className="ml-px inline-block h-3.5 w-0.5 animate-pulse bg-accent align-middle" />
                      </div>
                    </div>
                  ) : (
                    // Fallback pulse dots while waiting for first token.
                    <div className="rounded-xl bg-raised px-3.5 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                        <span className="text-xs text-fg-3">
                          {sessionStatus === "thinking" ? "Thinking..." : "Processing..."}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input — Gap 3: stays ENABLED during streaming for mid-execution steering */}
            {chatFiles.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chatFiles.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[11px] text-fg-2">
                    <Paperclip className="h-2.5 w-2.5" /> {f.name}
                    <button onClick={() => setChatFiles(prev => prev.filter((_, j) => j !== i))} className="ml-0.5 text-fg-3 hover:text-bad"><X className="h-2.5 w-2.5" /></button>
                  </span>
                ))}
              </div>
            )}
            {chatStreaming && sessionConnected && (
              <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent-soft border border-accent px-3 py-1.5">
                <Zap className="h-3 w-3 text-accent" />
                <span className="text-[11px] text-accent">Agent is responding -- you can send another message to steer the conversation</span>
              </div>
            )}
            {!canRun && <p className="mt-3 text-[11px] text-fg-3">Your role cannot send messages to agents (it spends money). Ask an owner or admin for the Member role.</p>}
            {canRun && <div className="mt-3 flex items-center gap-2">
              <button onClick={() => handleFileAttach(setChatFiles)} className="rounded-lg border border-line-strong p-2 text-fg-3 hover:bg-hover hover:text-fg" title="Attach file">
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                placeholder={chatStreaming && sessionConnected ? "Steer the agent -- send a follow-up..." : "Type a message..."}
                className="flex-1 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent"
              />
              <button
                onClick={handleChatSend}
                disabled={(!chatInput.trim() && chatFiles.length === 0) || !setupReady}
                title={!setupReady ? "Finish setup before sending" : undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2.5 text-xs font-medium text-on-action hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {chatStreaming && !sessionConnected ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              </button>
            </div>}
          </div>
        )}

        {/* RUNS TAB */}
        {activeTab === "observe" && (
          <div className="space-y-4">
            <ReliabilityStrip agentName={name} />
            <div className="flex flex-wrap items-center gap-3">
              {canRun && (
<Button
                variant="primary"
                size="md"
                loading={testRunning}
                icon={<Play className="h-3 w-3" />}
                onClick={async () => {
                  setTestRunning(true);
                  try {
                    const agentConf = JSON.parse(localStorage.getItem(`pal_agent_settings_${name}`) || "{}");
                    const run = await api.createRun({ agentName: name, input: { connectors: agentConf.connectors || [] } });
                    toast.success(`Run started: ${run.id.slice(0, 12)}...`);
                    // Refresh runs list after a delay
                    setTimeout(() => refreshRuns(), 3000);
                    setTimeout(() => refreshRuns(), 8000);
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : "Failed to create run";
                    toast.error(msg);
                  } finally {
                    setTestRunning(false);
                  }
                }}
                disabled={testRunning}
              >
                {testRunning ? "Running..." : "Run Now"}
              </Button>
)}
              <CostForecastBadge agentName={name} />
              {agentRuns.length >= 2 && (
                <Button variant={compareMode ? "primary" : "secondary"} size="md" icon={<GitCompare className="h-3 w-3" />} onClick={() => { setCompareMode(!compareMode); setCompareIds([null, null]); }}>
                  {compareMode ? "Exit Compare" : "Compare Runs"}
                </Button>
              )}
            </div>

            {/* Run Comparison View */}
            {compareMode && (
              <div className="rounded-xl border border-accent bg-panel p-4">
                <p className="mb-3 text-xs text-fg-2">Select two runs to compare side by side:</p>
                <div className="grid grid-cols-2 gap-4">
                  {([0, 1] as const).map((idx) => (
                    <div key={idx}>
                      <select value={compareIds[idx] || ""} onChange={(e) => { const ids = [...compareIds] as [string | null, string | null]; ids[idx] = e.target.value || null; setCompareIds(ids); }} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-xs text-fg outline-none">
                        <option value="">Select run...</option>
                        {agentRuns.map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 12)} - {r.status} {r.startedAt ? `(${format(new Date(r.startedAt), "MMM d HH:mm")})` : ""}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                {compareIds[0] && compareIds[1] && (() => {
                  const runA = agentRuns.find(r => r.id === compareIds[0]);
                  const runB = agentRuns.find(r => r.id === compareIds[1]);
                  if (!runA || !runB) return null;
                  const getOutput = (run: Run) => typeof run.output === "string" ? run.output : run.output ? JSON.stringify(run.output, null, 2) : "(no output)";
                  const durA = runA.startedAt ? new Date(runA.finishedAt ?? new Date()).getTime() - new Date(runA.startedAt).getTime() : 0;
                  const durB = runB.startedAt ? new Date(runB.finishedAt ?? new Date()).getTime() - new Date(runB.startedAt).getTime() : 0;
                  return (
                    <div className="mt-4 grid grid-cols-2 gap-4">
                      {[runA, runB].map((run, i) => {
                        const dur = i === 0 ? durA : durB;
                        return (
                          <div key={run.id} className="space-y-2 rounded-lg border border-line bg-canvas p-3">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={run.status} />
                              <span className="font-mono text-[11px] text-fg-3">{run.id.slice(0, 12)}</span>
                            </div>
                            <div className="flex gap-3 text-[11px] text-fg-3">
                              <span>{formatDuration(dur)}</span>
                              <span>{formatCost(run.costUsd)}</span>
                              <span>{(run.tokensIn + run.tokensOut).toLocaleString()} tokens</span>
                            </div>
                            <div className="max-h-40 overflow-auto rounded border border-line bg-panel p-2">
                              <pre className="whitespace-pre-wrap text-[12px] text-fg-2 font-sans">{getOutput(run).slice(0, 500)}</pre>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            )}

            {runsLoading ? (
              <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-fg-3" /></div>
            ) : agentRuns.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Play className="mb-3 h-8 w-8 text-fg-3" />
                <p className="text-sm text-fg-2">No runs yet.</p>
                <p className="mt-1 text-xs text-fg-3">Use the Build tab to test this agent.</p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-fg-3">{agentRuns.length} run{agentRuns.length !== 1 ? "s" : ""}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-fg-3">Page {runsPage + 1} of {Math.ceil(agentRuns.length / RUNS_PER_PAGE)}</span>
                    <button onClick={() => setRunsPage(p => Math.max(0, p - 1))} disabled={runsPage === 0} className="rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-hover disabled:opacity-30">Prev</button>
                    <button onClick={() => setRunsPage(p => Math.min(Math.ceil(agentRuns.length / RUNS_PER_PAGE) - 1, p + 1))} disabled={(runsPage + 1) * RUNS_PER_PAGE >= agentRuns.length} className="rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-hover disabled:opacity-30">Next</button>
                  </div>
                </div>
                <div className={clsx("grid gap-4 px-4 py-2 text-xs font-medium text-fg-3 pr-[76px]", RUN_COLS)}>
                  <span /><span>Status</span><span>Run</span><span className="text-right">Duration</span><span className="text-right">Cost</span><span>Started</span>
                </div>
                {agentRuns.slice(runsPage * RUNS_PER_PAGE, (runsPage + 1) * RUNS_PER_PAGE).map((run) => {
                  const expanded = expandedRunId === run.id;
                  const dur = run.startedAt ? formatDuration(new Date(run.finishedAt ?? new Date()).getTime() - new Date(run.startedAt).getTime()) : "--";
                  const confirmingDelete = deletingRunId === `confirm_${run.id}`;
                  return (
                    <div key={run.id} className="group rounded-lg border border-line bg-panel">
                      {/* Row with inline delete */}
                      <div className="flex items-center">
                        <button onClick={() => setExpandedRunId(expanded ? null : run.id)} className={clsx("grid flex-1 items-center gap-4 rounded-l-lg px-4 py-3 text-left text-sm hover:bg-hover", RUN_COLS)}>
                          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-fg-3 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-fg-3 shrink-0" />}
                          <StatusBadge status={run.status} />
                          <span className="truncate font-mono text-xs text-fg-3">{run.id.slice(0, 12)}</span>
                          <span className="text-right text-xs text-fg-2">{dur}</span>
                          <span className="text-right font-mono text-[12px] text-fg-3">{formatCost(run.costUsd)}</span>
                          <span className="text-[12px] text-fg-3">{run.startedAt ? format(new Date(run.startedAt), "MMM d, HH:mm") : "--"}</span>
                        </button>
                        {/* Delete — visible on hover or when confirming */}
                        <div className={clsx("flex w-[76px] shrink-0 items-center justify-end pr-2", confirmingDelete ? "opacity-100" : "opacity-0 group-hover:opacity-100 transition-opacity")}>
                          {!canRun ? null : confirmingDelete ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={async () => {
                                  setDeletingRunId(run.id);
                                  try { await api.deleteRun(run.id); toast.success("Deleted"); refreshRuns(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
                                  finally { setDeletingRunId(null); }
                                }}
                                disabled={deletingRunId === run.id}
                                className="rounded px-2 py-1 text-[11px] font-medium text-bad bg-bad-soft hover:bg-bad-soft"
                              >
                                {deletingRunId === run.id ? "..." : "Yes"}
                              </button>
                              <button onClick={() => setDeletingRunId(null)} className="rounded px-2 py-1 text-[11px] text-fg-3 hover:text-fg">No</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeletingRunId(`confirm_${run.id}`)} className="rounded p-1 text-fg-3 hover:text-bad hover:bg-bad-soft" title="Delete">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Expanded details */}
                      {expanded && (
                        <div className="border-t border-line p-4 space-y-4">
                          {/* Execution Steps */}
                          <ExecutionLog
                            steps={deduplicateSteps(run.triggerMeta)}
                            isRunDone={run.status === "succeeded" || run.status === "failed" || run.status === "cancelled"}
                            isRunning={run.status === "running"}
                          />
                          {/* Output */}
                          {run.output ? (
                            <div>
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-fg-3">Result</p>
                              <div className="max-h-80 overflow-auto rounded-lg border border-ok bg-ok-soft p-4">
                                {(() => {
                                  const raw = typeof run.output === "string" ? run.output : typeof run.output === "object" && run.output !== null && "result" in (run.output as Record<string, unknown>) ? String((run.output as Record<string, unknown>).result) : JSON.stringify(run.output, null, 2);
                                  const cleaned = raw.replace(/\*\*(.*?)\*\*/g, "$1").replace(/^#{1,3}\s+/gm, "").replace(/^- /gm, "  • ");
                                  return <pre className="whitespace-pre-wrap text-sm leading-relaxed text-fg font-sans">{cleaned}</pre>;
                                })()}
                              </div>
                            </div>
                          ) : run.error ? (
                            <div className="rounded-lg border border-bad bg-bad-soft p-3">
                              <p className="text-xs font-medium text-bad">{run.error.code}</p>
                              <p className="mt-1 text-xs text-bad">{run.error.message}</p>
                            </div>
                          ) : run.status === "running" ? (
                            <div className="flex items-center gap-2.5 py-3"><div className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" /><span className="text-sm text-fg-2">Processing...</span></div>
                          ) : <p className="text-xs text-fg-3">No output available.</p>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* SCHEDULE TAB */}
        {activeTab === "schedule" && (
          <div className="mx-auto max-w-2xl space-y-6">
            {!canWrite && <p className="rounded-lg bg-raised px-3 py-2 text-[11px] text-fg-3">Read-only for your role. Ask an owner or admin for the Member role to change the schedule.</p>}
            <fieldset disabled={!canWrite} className="m-0 min-w-0 rounded-xl border border-line bg-panel p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-fg">Cron Schedule</h3>
                <button type="button" role="switch" aria-checked={scheduleEnabled} onClick={() => setScheduleEnabled(!scheduleEnabled)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", scheduleEnabled ? "bg-accent" : "bg-line-strong")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", scheduleEnabled ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs text-fg-2">Cron expression</label>
                  <AiAssistButton mode="cron" value={settingsCron} onChange={setSettingsCron} placeholder="e.g., every weekday at 9am" />
                </div>
                <input type="text" value={settingsCron} onChange={(e) => setSettingsCron(e.target.value)} placeholder="0 9 * * 1-5" className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg font-mono placeholder:text-fg-3 outline-none focus:border-accent" />
                {settingsCron && <p className="mt-1 text-[11px] text-fg-3">{describeCron(settingsCron)}</p>}
                {nextFireAt && <p className="mt-1 text-[11px] text-fg-3">Next fire: {new Date(nextFireAt).toLocaleString()}</p>}
              </div>

              <div className="border-t border-line pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div><label className="text-xs font-medium text-fg-2">Email delivery</label><p className="text-[11px] text-fg-3">Send run output via email</p></div>
                  <button type="button" role="switch" aria-checked={deliveryEmailEnabled} onClick={() => setDeliveryEmailEnabled(!deliveryEmailEnabled)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", deliveryEmailEnabled ? "bg-accent" : "bg-line-strong")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", deliveryEmailEnabled ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                {deliveryEmailEnabled && <input type="email" value={deliveryEmail} onChange={(e) => setDeliveryEmail(e.target.value)} placeholder="you@example.com" className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent" />}
              </div>

              {/* Webhook */}
              <div className="border-t border-line pt-4 space-y-2">
                <h4 className="flex items-center gap-2 text-xs font-medium text-fg-2"><Webhook className="h-3.5 w-3.5 text-accent" /> Webhook</h4>
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded-lg border border-line bg-canvas px-3 py-2 font-mono text-xs text-fg-2 select-all">{apiBase}/v1/agents/{name}/trigger</code>
                  <button onClick={() => navigator.clipboard.writeText(`${apiBase}/v1/agents/${name}/trigger`)} className="rounded-lg border border-line-strong px-3 py-2 text-xs font-medium text-fg-2 hover:bg-hover">Copy</button>
                </div>
              </div>

              {canWrite && (
<button onClick={handleSaveSchedule} disabled={savingSchedule || !settingsCron.trim()} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-medium text-on-action hover:opacity-90 disabled:opacity-50">
                {savingSchedule ? <><Loader2 className="h-3 w-3 animate-spin" /> Saving...</> : <><Save className="h-3 w-3" /> Save Schedule</>}
              </button>
)}
            </fieldset>
          </div>
        )}

        {/* SETTINGS TAB */}
        {activeTab === "security" && <SecurityTab name={name} />}

        {activeTab === "settings" && (
          <div className="mx-auto max-w-2xl space-y-6">
            {!canWrite && <p className="rounded-lg bg-raised px-3 py-2 text-[11px] text-fg-3">Read-only for your role. Ask an owner or admin for the Member role to change this agent.</p>}
            {/* Webhook triggers (ADR 0028) */}
            <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel p-5">
              <div>
                <h3 className="text-sm font-semibold text-fg">Webhook triggers</h3>
                <p className="text-[11px] text-fg-3">Run this agent when GitHub, Sentry, PagerDuty or any signed webhook fires.</p>
              </div>
              <LinkButton href={`/agents/${encodeURIComponent(name)}/triggers`} size="sm">Manage</LinkButton>
            </div>

            <fieldset disabled={!canWrite} className="m-0 min-w-0 space-y-6 border-0 p-0">
            {/* Default Model */}
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <h3 className="text-sm font-semibold text-fg">Default Model</h3>
              <ModelSelect value={settingsModel} onChange={setSettingsModel} className="w-full" />
            </div>

            {/* Isolation */}
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <h3 className="text-sm font-semibold text-fg">Isolation</h3>
              <div className="space-y-2">
                {ISOLATION_LEVELS.map((level) => (
                  <label key={level.value} className={clsx("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-all", settingsIsolation === level.value ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong")}>
                    <input type="radio" name="isolation" value={level.value} checked={settingsIsolation === level.value} onChange={(e) => setSettingsIsolation(e.target.value)} className="accent-accent" />
                    <div><div className="text-xs font-medium text-fg">{level.label}</div><div className="text-[11px] text-fg-3">{level.desc}</div></div>
                  </label>
                ))}
              </div>
            </div>

            {/* Gap 2: Managed Environment Settings */}
            <div className="rounded-xl border border-ok bg-panel p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-ok" />
                <h3 className="text-sm font-semibold text-fg">Environment</h3>
                <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[9px] font-medium text-ok">Managed</span>
              </div>
              <p className="text-[11px] text-fg-3">Configure the managed runtime environment for this agent. Changes are saved locally and will apply to future deployments.</p>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Runtime</label>
                  <select value={envRuntime} onChange={(e) => { setEnvRuntime(e.target.value); try { const s = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}"); s.runtime = e.target.value; localStorage.setItem(`pal_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                    <option value="node22">Node.js 22 (default)</option>
                    <option value="python312">Python 3.12</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Memory</label>
                  <select value={envMemory} onChange={(e) => { setEnvMemory(e.target.value); try { const s = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}"); s.memory = e.target.value; localStorage.setItem(`pal_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                    <option value="256mb">256MB</option>
                    <option value="512mb">512MB (default)</option>
                    <option value="1gb">1GB</option>
                    <option value="2gb">2GB</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Timeout</label>
                  <select value={envTimeout} onChange={(e) => { setEnvTimeout(e.target.value); try { const s = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}"); s.timeout = e.target.value; localStorage.setItem(`pal_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                    <option value="1m">1 minute</option>
                    <option value="5m">5 minutes (default)</option>
                    <option value="15m">15 minutes</option>
                    <option value="30m">30 minutes</option>
                    <option value="1h">1 hour</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Network Access</label>
                  <select value={envNetwork} onChange={(e) => { setEnvNetwork(e.target.value); try { const s = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}"); s.network = e.target.value; localStorage.setItem(`pal_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                    <option value="allow-all">Allow all</option>
                    <option value="restricted">Restricted</option>
                    <option value="no-egress">No egress</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Additional Packages (comma-separated)</label>
                  <input type="text" value={envPackages} onChange={(e) => { setEnvPackages(e.target.value); try { const s = JSON.parse(localStorage.getItem(`pal_env_${name}`) || "{}"); s.packages = e.target.value; localStorage.setItem(`pal_env_${name}`, JSON.stringify(s)); } catch { /* */ } }} placeholder="e.g., axios, lodash, cheerio" className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent" />
                </div>
              </div>
            </div>

            {/* Resource Limits */}
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <h3 className="text-sm font-semibold text-fg">Resource Limits</h3>
              <div className="space-y-3">
                <div><label className="mb-1 block text-xs text-fg-2">Timeout</label>
                  <select value={settingsTimeout} onChange={(e) => setSettingsTimeout(e.target.value)} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                    <option value="1m">1 minute</option><option value="5m">5 minutes</option><option value="15m">15 minutes</option><option value="30m">30 minutes</option><option value="1h">1 hour</option>
                  </select>
                </div>
                <div><label className="mb-1 flex items-center justify-between text-xs text-fg-2">Max tokens <span className="font-mono text-fg-3">{settingsMaxTokens.toLocaleString()}</span></label>
                  <input type="range" min={1000} max={500000} step={1000} value={settingsMaxTokens} onChange={(e) => setSettingsMaxTokens(parseInt(e.target.value))} className="w-full accent-accent" />
                </div>
                <div><label className="mb-1 flex items-center justify-between text-xs text-fg-2">Max cost <span className="font-mono text-fg-3">${settingsMaxCost.toFixed(2)}</span></label>
                  <input type="range" min={0.1} max={50} step={0.1} value={settingsMaxCost} onChange={(e) => setSettingsMaxCost(parseFloat(e.target.value))} className="w-full accent-accent" />
                </div>
              </div>
            </div>

            {/* Privacy & Security */}
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <h3 className="text-sm font-semibold text-fg">Privacy & Security</h3>
              <div><label className="mb-1 block text-xs text-fg-2">Data retention period</label>
                <select value={settingsRetention} onChange={(e) => setSettingsRetention(e.target.value)} className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg outline-none focus:border-accent">
                  <option value="30d">30 days</option><option value="90d">90 days</option><option value="180d">180 days</option><option value="365d">1 year</option><option value="forever">Forever</option>
                </select>
              </div>
              <div className="flex items-center justify-between">
                <div><span className="text-xs font-medium text-fg-2">{"\uD83D\uDD12"} Encrypt all run data</span><p className="text-[11px] text-fg-3">End-to-end encryption for all inputs and outputs</p></div>
                <button type="button" role="switch" aria-checked={settingsEncrypt} onClick={() => setSettingsEncrypt(!settingsEncrypt)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", settingsEncrypt ? "bg-accent" : "bg-line-strong")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", settingsEncrypt ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div className="flex items-center justify-between">
                <div><span className="text-xs font-medium text-fg-2">{"\uD83D\uDEE1\uFE0F"} Enable audit logging</span><p className="text-[11px] text-fg-3">Full audit trail for compliance</p></div>
                <button type="button" role="switch" aria-checked={settingsAuditLog} onClick={() => setSettingsAuditLog(!settingsAuditLog)} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", settingsAuditLog ? "bg-accent" : "bg-line-strong")}>
                  <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", settingsAuditLog ? "translate-x-4" : "translate-x-0.5")} />
                </button>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2">
                <span className="text-[11px] font-medium text-fg-2">Data residency:</span>
                <span className="rounded bg-raised px-2 py-0.5 text-[11px] font-medium text-fg-2">US-East-1</span>
              </div>
            </div>

            <AgentMcpSection agentName={name} />

            {/* Safety & Guardrails */}
            <div className="rounded-xl border border-line bg-panel p-5 space-y-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-fg"><ShieldAlert className="h-4 w-4 text-warn" /> Safety & Guardrails</h3>
              <p className="text-[11px] text-fg-3">Client-side filters applied to agent output before display</p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-fg-2">Enable content filtering</span><p className="text-[11px] text-fg-3">Flag and redact potential secrets in output</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.contentFilter} onClick={() => handleSaveGuardrails({ ...guardrails, contentFilter: !guardrails.contentFilter })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.contentFilter ? "bg-accent" : "bg-line-strong")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.contentFilter ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-fg-2">Block PII in output</span><p className="text-[11px] text-fg-3">Redact emails, phone numbers, SSNs, card numbers</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.blockPII} onClick={() => handleSaveGuardrails({ ...guardrails, blockPII: !guardrails.blockPII })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.blockPII ? "bg-accent" : "bg-line-strong")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.blockPII ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <div><span className="text-xs font-medium text-fg-2">Block toxic content</span><p className="text-[11px] text-fg-3">Block output containing harmful or toxic content</p></div>
                  <button type="button" role="switch" aria-checked={guardrails.blockToxic} onClick={() => handleSaveGuardrails({ ...guardrails, blockToxic: !guardrails.blockToxic })} className={clsx("relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", guardrails.blockToxic ? "bg-accent" : "bg-line-strong")}>
                    <span className={clsx("inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform", guardrails.blockToxic ? "translate-x-4" : "translate-x-0.5")} />
                  </button>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-2">Blocked topics (comma-separated)</label>
                  <input type="text" value={blockedTopicsInput} onChange={(e) => { setBlockedTopicsInput(e.target.value); const topics = e.target.value.split(",").map(t => t.trim()).filter(Boolean); handleSaveGuardrails({ ...guardrails, blockedTopics: topics }); }} placeholder="e.g., politics, religion, violence" className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-fg placeholder:text-fg-3 outline-none focus:border-accent" />
                </div>
                <div>
                  <label className="mb-1 flex items-center justify-between text-xs text-fg-2">Max response length <span className="font-mono text-fg-3">{guardrails.maxResponseLength === 0 ? "Unlimited" : `${guardrails.maxResponseLength.toLocaleString()} chars`}</span></label>
                  <input type="range" min={0} max={10000} step={100} value={guardrails.maxResponseLength} onChange={(e) => handleSaveGuardrails({ ...guardrails, maxResponseLength: parseInt(e.target.value) })} className="w-full accent-accent" />
                </div>
              </div>
              {hasActiveGuardrails(guardrails) && (
                <div className="flex items-center gap-1.5 rounded-lg bg-warn-soft px-3 py-2 text-[11px] text-warn">
                  <ShieldAlert className="h-3 w-3" /> Guardrails active -- output will be filtered
                </div>
              )}
            </div>

            {canWrite && (
            <button onClick={handleSaveSettings} disabled={savingSettings} className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 text-sm font-medium text-on-action hover:opacity-90 disabled:opacity-50">
              {savingSettings ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving...</> : "Save Settings"}
            </button>
            )}
            </fieldset>

            {/* A2A Agent Card: live from the control plane (ADR 0057) */}
            <AgentA2aCard name={name} />

            {/* Deploy to Cloud (Gap 5) */}
            <div className="rounded-xl border border-accent bg-panel p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Cloud className="h-4 w-4 text-accent" />
                <h3 className="text-sm font-semibold text-fg">Deploy to PAL Cloud</h3>
                {cloudDeployStatus === "live" && <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[9px] font-medium text-ok">Live</span>}
                {cloudDeployStatus === "stopped" && <span className="rounded-full bg-raised px-2 py-0.5 text-[9px] font-medium text-fg-2">Stopped</span>}
              </div>
              <p className="text-[11px] text-fg-3">Deploy this agent to PAL Cloud for managed hosting with usage-based billing. No infrastructure to manage.</p>
              {canWrite && cloudDeployStatus === "not_deployed" && (
                <button onClick={async () => { setDeploying(true); try { const result = await api.deployAgent(name); setCloudDeployStatus(result.status); setCloudDeployUrl(result.url); localStorage.setItem(`pal_deploy_${name}`, JSON.stringify({ status: result.status, url: result.url })); toast.success("Agent deployed to PAL Cloud"); } catch (err) { toast.error(`Deploy failed — ${err instanceof Error ? err.message : String(err)}`); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2.5 text-sm font-medium text-on-action transition-colors hover:opacity-90 disabled:opacity-50">
                  {deploying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deploying...</> : <><Cloud className="h-3.5 w-3.5" /> Deploy to Cloud</>}
                </button>
              )}
              {cloudDeployStatus === "live" && (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-fg-2">Live URL</label>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded-lg border border-ok bg-canvas px-3 py-2 font-mono text-xs text-ok select-all">{cloudDeployUrl || "not reported by the deployment"}</code>
                      <button disabled={!cloudDeployUrl} onClick={() => { navigator.clipboard.writeText(cloudDeployUrl); toast.success("URL copied"); }} className="inline-flex items-center gap-1 rounded-lg border border-line-strong px-3 py-2 text-xs font-medium text-fg-2 hover:bg-hover">
                        <Copy className="h-3 w-3" /> Copy
                      </button>
                    </div>
                  </div>
                  {canWrite && <div className="flex items-center gap-2">
                    <button onClick={async () => { setDeploying(true); try { await api.deployAgent(name); toast.success("Agent redeployed"); } catch (err) { toast.error(`Redeploy failed — ${err instanceof Error ? err.message : String(err)}`); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fg-2 hover:bg-hover disabled:opacity-50">
                      {deploying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cloud className="h-3 w-3" />} Redeploy
                    </button>
                    <button onClick={async () => { setStopping(true); try { await api.stopCloudDeployment(name); setCloudDeployStatus("stopped"); setCloudDeployUrl(""); localStorage.setItem(`pal_deploy_${name}`, JSON.stringify({ status: "stopped", url: "" })); toast.success("Deployment stopped"); } catch (err) { toast.error(`Failed to stop deployment — ${err instanceof Error ? err.message : String(err)}`); } finally { setStopping(false); } }} disabled={stopping} className="inline-flex items-center gap-2 rounded-lg border border-bad px-3 py-1.5 text-xs font-medium text-bad hover:bg-bad-soft disabled:opacity-50">
                      {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} Stop
                    </button>
                  </div>}
                </div>
              )}
              {cloudDeployStatus === "stopped" && (
                <div className="space-y-3">
                  <p className="text-xs text-fg-3">This agent was previously deployed and is now stopped.</p>
                  {canWrite && <button onClick={async () => { setDeploying(true); try { const result = await api.deployAgent(name); setCloudDeployStatus(result.status); setCloudDeployUrl(result.url); localStorage.setItem(`pal_deploy_${name}`, JSON.stringify({ status: result.status, url: result.url })); toast.success("Agent redeployed"); } catch (err) { toast.error(`Redeploy failed — ${err instanceof Error ? err.message : String(err)}`); } finally { setDeploying(false); } }} disabled={deploying} className="inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2 text-sm font-medium text-on-action transition-colors hover:opacity-90 disabled:opacity-50">
                    {deploying ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deploying...</> : <><Cloud className="h-3.5 w-3.5" /> Redeploy</>}
                  </button>}
                </div>
              )}
            </div>

            {/* Danger Zone */}
            {canWrite && <div className="rounded-xl border border-bad bg-bad-soft p-5 space-y-3">
              <h3 className="text-sm font-semibold text-bad">Danger Zone</h3>
              <p className="text-xs text-fg-3">Deleting this agent will remove it and all associated data. This cannot be undone.</p>
              <div className="text-xs text-fg-3">{agentRuns.length} runs, {succeededRuns} succeeded, {formatCost(totalCost)} total cost</div>
              <button onClick={() => setShowDeleteConfirm(true)} className="inline-flex items-center gap-2 rounded-lg border border-bad px-4 py-2 text-xs font-medium text-bad hover:bg-bad-soft">
                <Trash2 className="h-3 w-3" /> Delete Agent
              </button>
            </div>}
          </div>
        )}
      </div>

      <ConfirmModal
        open={showDeleteConfirm}
        title={`Delete ${name}?`}
        description={`This removes the agent and its versions (${agentRuns.length} runs, ${formatCost(totalCost)} spent stay in history). This can’t be undone.`}
        confirmLabel="Delete agent"
        tone="danger"
        confirming={deleting}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}
