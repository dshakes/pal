"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api, type RunFilters, notifySimulated } from "@/lib/api";
// Types only — every hook below treats the API as the single source of truth.
// On failure we surface an explicit error / empty state, never mock data.
import type { Agent, Run, StreamEvent, ApiKey, AgentVersion } from "@/lib/types";
import { mergeEvent, type StreamState } from "@/lib/sse";

// ---------------------------------------------------------------------------
// useSafeData pattern — every hook returns { data, loading, error, isDemo }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// useAgents
// ---------------------------------------------------------------------------

export function useAgents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listAgents();
      setAgents(data);
      setIsDemo(false);
    } catch (err) {
      // API unavailable — surface the error explicitly + render an
      // empty list. The page's empty state handles "no agents yet"
      // vs. "agents existed but we couldn't fetch them" via the
      // `error` field, not by injecting fake rows.
      notifySimulated("listAgents", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agents, setAgents, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgent
// ---------------------------------------------------------------------------

export function useAgent(name: string) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAgent(name);
      setAgent(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agent, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgentVersions
// ---------------------------------------------------------------------------

export function useAgentVersions(agentName: string) {
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAgentVersions(agentName);
      setVersions(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { versions, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useAgentRuns
// ---------------------------------------------------------------------------

export function useAgentRuns(agentName: string) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRunsForAgent(agentName);
      setRuns(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRuns
// ---------------------------------------------------------------------------

export function useRuns(filters?: RunFilters) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listRuns(filters);
      setRuns(data);
      setIsDemo(false);
    } catch (err) {
      // API unavailable — empty list + surface the error. Consumers
      // (Runs page, Inbox) show their real empty/error state instead
      // of a wall of mock rows that look indistinguishable from real.
      notifySimulated("listRuns", err);
      setError(err instanceof Error ? err : new Error(String(err)));
      setRuns([]);
    } finally {
      setLoading(false);
    }
  }, [filters?.agentName, filters?.status, filters?.search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { runs, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRun
// ---------------------------------------------------------------------------

export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);
  // Guards against a slow response for a stale `id` (e.g. the user navigated
  // from run A to run B before A's fetch resolved) overwriting the currently
  // viewed run with the wrong data.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const thisRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.getRun(id);
      if (requestId.current !== thisRequest) return;
      setRun(data);
      setIsDemo(false);
    } catch (err) {
      if (requestId.current !== thisRequest) return;
      // getRun already falls back to mock data inside api.ts,
      // so if we get here the run truly doesn't exist
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (requestId.current === thisRequest) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { run, loading, error, isDemo, refresh };
}

// ---------------------------------------------------------------------------
// useRunEvents — live SSE streaming with mock fallback
// ---------------------------------------------------------------------------

/**
 * Live run events. `reopenKey` (the run's status) reopens the stream when it
 * changes: the server's tail only sends rows past the last seq, so a row it
 * rewrites in place (an approval's step_waiting → step_completed) arrives only
 * in a fresh connection's replay. Events merge by seq, so a reopen never
 * flickers or duplicates.
 */
export function useRunEvents(runId: string, reopenKey?: string) {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [state, setState] = useState<StreamState>("connecting");
  // Reopen only when the key changes between two KNOWN values — the first
  // value arriving (undefined → status, on every page load) is not a change.
  const lastKey = useRef<string | undefined>(undefined);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (reopenKey === undefined) return;
    if (lastKey.current !== undefined && lastKey.current !== reopenKey) setEpoch((n) => n + 1);
    lastKey.current = reopenKey;
  }, [reopenKey]);

  useEffect(() => {
    setEvents([]);
    lastKey.current = undefined;
  }, [runId]);

  useEffect(() => {
    const stream = api.streamRunEvents(runId);
    stream.subscribe((event) => setEvents((prev) => mergeEvent(prev, event)), setState);
    return () => stream.close();
  }, [runId, epoch]);

  return { events, state, connected: state === "live" };
}

// ---------------------------------------------------------------------------
// useApiKeys
// ---------------------------------------------------------------------------

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listApiKeys();
      setKeys(data);
      setIsDemo(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { keys, setKeys, loading, error, isDemo, refresh };
}
