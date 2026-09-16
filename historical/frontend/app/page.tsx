"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MsgRole = "user" | "assistant" | "system";
type Msg = { role: MsgRole; text: string };

type Offer = {
  niche?: string;
  city?: string;
  offer_name?: string;
  offer_value?: string;
  offer_bullets?: string[];
  lead_query?: string;
};

type Lead = {
  id?: number;
  company_name?: string;
  title?: string;
  url?: string;
  domain?: string;
  email?: string;
  contact_url?: string;
  score?: number;
  reasons?: string[];
  stage?: string;
  snippet?: string;
};

type ActionStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "completed"
  | "rejected"
  | "failed"
  | "blocked";

type QueueAction = {
  id: string;
  action_type: string;
  layer: string;
  title: string;
  detail: string;
  status: ActionStatus;
  needs_approval: number;
  reversible: number;
  command?: string;
  error?: string;
  rollback_hint?: string;
  result?: Record<string, unknown>;
};

type PlanItem = {
  id: string;
  layer: string;
  title: string;
  status: string;
  notes?: string;
};

type ActivityLog = {
  id: number;
  event_type: string;
  message: string;
  created_at: string;
};

type SessionState = {
  user_id: string;
  goal: string;
  run_count: number;
  require_approval: boolean;
  kill_switch: boolean;
  os_control_granted: boolean;
  workspace_root: string;
  desktop_prompts: boolean;
  deploy_provider: "vercel" | "netlify";
  use_playwright: boolean;
  project_slug: string;
  project_dir: string;
};

type ArtifactState = {
  project_dir: string;
  drafts_path: string;
  workspace_root?: string;
  deploy_provider?: "vercel" | "netlify";
  preview_paths: {
    site: string;
    emails: string;
    report: string;
  };
};

type ApiResp = {
  reply: string;
  data?: {
    offer?: Offer;
    leads?: Lead[];
    outreach?: string;
    landing?: string;
    status?: string;
    error?: string;
    plan?: PlanItem[];
  };
};

type StateResp = {
  session: SessionState;
  plan: PlanItem[];
  offer: Offer;
  landing: string;
  outreach: string;
  leads: Lead[];
  queue: QueueAction[];
  logs: ActivityLog[];
  artifacts?: ArtifactState;
};

type FlowStep = {
  id: "goal" | "plan" | "execute" | "review";
  title: string;
  subtitle: string;
};

const FLOW_STEPS: FlowStep[] = [
  { id: "goal", title: "1. Define Goal", subtitle: "Describe what to build" },
  { id: "plan", title: "2. Inspect Plan", subtitle: "Review offer + leads" },
  { id: "execute", title: "3. Approve Actions", subtitle: "Execute safely" },
  { id: "review", title: "4. Review Outputs", subtitle: "Open previews and artifacts" },
];

function clsx(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

function makeUserId() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  return `u_${arr[0]}${arr[1]}`;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function MessageBubble({ role, text }: { role: MsgRole; text: string }) {
  const isUser = role === "user";
  const isSystem = role === "system";

  return (
    <div className={clsx("mb-3 flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={clsx(
          "max-w-[92%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
          isSystem
            ? "border border-amber-700 bg-amber-950/40 text-amber-100"
            : isUser
              ? "border border-emerald-400/40 bg-emerald-500/10 text-emerald-50"
              : "border border-slate-700 bg-slate-900/60 text-slate-100"
        )}
      >
        {text}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ActionStatus }) {
  const cls =
    status === "completed"
      ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-100"
      : status === "approved"
        ? "border-sky-400/40 bg-sky-500/20 text-sky-100"
        : status === "pending_approval"
          ? "border-amber-400/40 bg-amber-500/20 text-amber-100"
          : status === "running"
            ? "border-indigo-400/40 bg-indigo-500/20 text-indigo-100"
            : "border-rose-400/40 bg-rose-500/20 text-rose-100";
  return <span className={clsx("rounded-full border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide", cls)}>{status.replaceAll("_", " ")}</span>;
}

export default function Home() {
  const backend = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

  const [mounted, setMounted] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<FlowStep["id"]>("goal");

  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "assistant",
      text:
        "JARVIS Operator is online.\n\n" +
        "Describe your business goal, then add RUN when you want the pipeline executed.\n" +
        "Execution now starts with an OS-control permission gate before browser/shell actions.",
    },
  ]);

  const [offer, setOffer] = useState<Offer | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [landing, setLanding] = useState("");
  const [outreach, setOutreach] = useState("");
  const [queueActions, setQueueActions] = useState<QueueAction[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactState | null>(null);

  const [killSwitch, setKillSwitch] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(true);
  const [desktopPrompts, setDesktopPrompts] = useState(true);
  const [deployProvider, setDeployProvider] = useState<"vercel" | "netlify">("vercel");
  const [usePlaywright, setUsePlaywright] = useState(true);
  const [workspaceRootInput, setWorkspaceRootInput] = useState("");
  const [revisionInput, setRevisionInput] = useState("");
  const [revisionBusy, setRevisionBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Planning");
  const [queueBusy, setQueueBusy] = useState(false);

  useEffect(() => {
    setMounted(true);
    setUserId((prev) => prev ?? makeUserId());
  }, []);

  const chatRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = chatRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [msgs, busy]);

  const pendingCount = useMemo(() => queueActions.filter((x) => x.status === "pending_approval").length, [queueActions]);
  const approvedCount = useMemo(() => queueActions.filter((x) => x.status === "approved").length, [queueActions]);
  const completedCount = useMemo(() => queueActions.filter((x) => x.status === "completed").length, [queueActions]);

  const canSend = input.trim().length > 0 && !busy && !!userId && !killSwitch;

  const refreshState = useCallback(async (targetUserId?: string) => {
    const activeUser = targetUserId || userId;
    if (!activeUser) return;

    try {
      const res = await fetch(`${backend}/state/${activeUser}`);
      if (!res.ok) return;
      const state = (await res.json()) as StateResp;
      setSessionState(state.session);
      setPlan(state.plan || []);
      setOffer(state.offer || null);
      setLeads(state.leads || []);
      setLanding(state.landing || "");
      setOutreach(state.outreach || "");
      setQueueActions(state.queue || []);
      setActivityLogs(state.logs || []);
      setArtifacts(state.artifacts || null);
      setKillSwitch(Boolean(state.session.kill_switch));
      setApprovalRequired(Boolean(state.session.require_approval));
      setDesktopPrompts(Boolean(state.session.desktop_prompts));
      setDeployProvider(state.session.deploy_provider === "netlify" ? "netlify" : "vercel");
      setUsePlaywright(Boolean(state.session.use_playwright));
      setWorkspaceRootInput((prev) => prev || state.session.workspace_root || "");
    } catch {
      // ignore transient failures
    }
  }, [backend, userId]);

  useEffect(() => {
    if (!userId) return;
    void refreshState(userId);
    const timer = setInterval(() => {
      void refreshState(userId);
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshState, userId]);

  async function send(forceRun?: boolean) {
    if (!userId || killSwitch) return;

    let text = input.trim();
    if (!text) return;

    if (forceRun && !/(\s|^)RUN(\s|$)/i.test(text)) {
      text = `${text} RUN`;
    }

    setInput("");
    setMsgs((prev) => [...prev, { role: "user", text }]);

    const isRun = /(\s|^)RUN(\s|$)/i.test(text);
    setBusy(true);
    setBusyLabel(isRun ? "Executing pipeline" : "Planning");

    const contextMsgs = [...msgs, { role: "user" as const, text }].slice(-12);

    try {
      const res = await fetch(`${backend}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, message: text, context: contextMsgs }),
      });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);

      const data = (await res.json()) as ApiResp;
      setMsgs((prev) => [...prev, { role: "assistant", text: data.reply }]);

      if (data.data?.offer) setOffer(data.data.offer);
      if (data.data?.leads) setLeads(data.data.leads);
      if (typeof data.data?.landing === "string") setLanding(data.data.landing);
      if (typeof data.data?.outreach === "string") setOutreach(data.data.outreach);
      if (Array.isArray(data.data?.plan)) setPlan(data.data.plan);

      if (data.data?.status === "ran") {
        setCurrentStep("execute");
      }

      await refreshState(userId);
    } catch {
      setMsgs((prev) => [
        ...prev,
        {
          role: "system",
          text:
            "Could not reach backend.\n" +
            "- Check http://localhost:8000/docs\n" +
            "- Ensure backend terminal has no errors",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function toggleKillSwitch() {
    if (!userId) return;
    const next = !killSwitch;
    try {
      await fetch(`${backend}/session/kill-switch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, enabled: next }),
      });
      setKillSwitch(next);
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update kill switch." }]);
    }
  }

  async function toggleApproval() {
    if (!userId) return;
    const next = !approvalRequired;
    try {
      await fetch(`${backend}/session/approval-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, required: next }),
      });
      setApprovalRequired(next);
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update approval mode." }]);
    }
  }

  async function toggleDesktopPromptMode() {
    if (!userId) return;
    const next = !desktopPrompts;
    try {
      await fetch(`${backend}/session/desktop-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, enabled: next }),
      });
      setDesktopPrompts(next);
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update desktop prompts mode." }]);
    }
  }

  async function togglePlaywrightMode() {
    if (!userId) return;
    const next = !usePlaywright;
    try {
      await fetch(`${backend}/session/browser-automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, use_playwright: next }),
      });
      setUsePlaywright(next);
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update browser automation mode." }]);
    }
  }

  async function setDeployProviderMode(provider: "vercel" | "netlify") {
    if (!userId) return;
    try {
      await fetch(`${backend}/session/deploy-provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, provider }),
      });
      setDeployProvider(provider);
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update deploy provider." }]);
    }
  }

  async function saveWorkspaceRoot() {
    if (!userId || !workspaceRootInput.trim()) return;
    try {
      const res = await fetch(`${backend}/session/workspace-root`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, path: workspaceRootInput.trim() }),
      });
      if (!res.ok) throw new Error("workspace root update failed");
      await refreshState(userId);
      setMsgs((prev) => [...prev, { role: "system", text: "Workspace root updated." }]);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to update workspace root." }]);
    }
  }

  async function queueSiteRevision() {
    if (!userId || !revisionInput.trim()) return;
    setRevisionBusy(true);
    try {
      const res = await fetch(`${backend}/site/revision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, instructions: revisionInput.trim() }),
      });
      if (!res.ok) throw new Error("revision queue failed");
      setMsgs((prev) => [
        ...prev,
        { role: "assistant", text: `Queued site revision actions:\n${revisionInput.trim()}` },
      ]);
      setRevisionInput("");
      setCurrentStep("execute");
      await refreshState(userId);
    } catch {
      setMsgs((prev) => [...prev, { role: "system", text: "Failed to queue site revision." }]);
    } finally {
      setRevisionBusy(false);
    }
  }

  async function approveAction(actionId: string) {
    if (!userId) return;
    await fetch(`${backend}/queue/${actionId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    await refreshState(userId);
  }

  async function rejectAction(actionId: string) {
    if (!userId) return;
    await fetch(`${backend}/queue/${actionId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    await refreshState(userId);
  }

  async function executeAction(actionId: string) {
    if (!userId || killSwitch) return;
    setQueueBusy(true);
    await fetch(`${backend}/queue/${actionId}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    await refreshState(userId);
    setQueueBusy(false);
  }

  async function executeApproved() {
    if (!userId || killSwitch) return;
    setQueueBusy(true);
    await fetch(`${backend}/queue/execute-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, limit: 20 }),
    });
    await refreshState(userId);
    setQueueBusy(false);
  }

  function openPreview(key: keyof ArtifactState["preview_paths"]) {
    if (!artifacts?.preview_paths?.[key]) return;
    const url = `${backend}${artifacts.preview_paths[key]}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function openAllPreviews() {
    if (!artifacts?.preview_paths) return;
    const keys: Array<keyof ArtifactState["preview_paths"]> = ["site", "emails", "report"];
    for (const key of keys) {
      const url = `${backend}${artifacts.preview_paths[key]}`;
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <main className="min-h-screen pb-12 text-slate-100">
      <div className="mx-auto max-w-[1280px] px-4 py-6 sm:px-6 lg:px-8">
        <section className="panel step-shell">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-4xl">
              <p className="mono text-xs uppercase tracking-[0.16em] text-emerald-300/80">JARVIS // Business Operator</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-emerald-100 sm:text-4xl">
                AI assistant flow with laptop control, site generation, revision loops, deployment, and outreach.
              </h1>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="chip">Backend: {backend}</span>
                <span className="chip">User: {!mounted || !userId ? "loading" : userId}</span>
                <span className="chip">Runs: {sessionState?.run_count ?? 0}</span>
                <span className={clsx("chip", killSwitch ? "chip-critical" : "chip-live")}>{killSwitch ? "Kill Switch On" : "Execution Available"}</span>
                <span className={clsx("chip", sessionState?.os_control_granted ? "chip-live" : "")}>
                  OS Control: {sessionState?.os_control_granted ? "granted" : "not granted"}
                </span>
                <span className="chip">Deploy: {deployProvider}</span>
                <span className={clsx("chip", desktopPrompts ? "chip-live" : "")}>Desktop Popups: {desktopPrompts ? "on" : "off"}</span>
              </div>
              {sessionState?.project_dir ? <p className="mono mt-3 text-xs text-emerald-200/70">project_dir: {sessionState.project_dir}</p> : null}
              {sessionState?.workspace_root ? <p className="mono mt-1 text-xs text-emerald-200/60">workspace_root: {sessionState.workspace_root}</p> : null}
            </div>

            <div className="w-full max-w-[460px] space-y-2">
              <div className="flex flex-wrap gap-2">
                <button className="action-btn" onClick={toggleApproval}>
                  Approvals: {approvalRequired ? "required" : "manual"}
                </button>
                <button className="action-btn" onClick={toggleDesktopPromptMode}>
                  Desktop Popups: {desktopPrompts ? "on" : "off"}
                </button>
                <button className="action-btn" onClick={togglePlaywrightMode}>
                  Browser Agent: {usePlaywright ? "playwright" : "browser"}
                </button>
                <button className="action-btn" onClick={toggleKillSwitch}>
                  {killSwitch ? "Release Kill Switch" : "Engage Kill Switch"}
                </button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  className="h-10 flex-1 rounded-lg border border-emerald-500/25 bg-slate-900 px-3 text-xs text-emerald-50 outline-none focus:border-emerald-400"
                  value={workspaceRootInput}
                  placeholder="Business root path (e.g. D:\\AI-Businesses)"
                  onChange={(e) => setWorkspaceRootInput(e.target.value)}
                />
                <button className="secondary-btn" onClick={() => void saveWorkspaceRoot()}>
                  Set Path
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="mono text-[11px] text-emerald-200/70">Deploy:</span>
                <button
                  className={clsx("secondary-btn", deployProvider === "vercel" && "ring-1 ring-emerald-400/60")}
                  onClick={() => void setDeployProviderMode("vercel")}
                >
                  Vercel
                </button>
                <button
                  className={clsx("secondary-btn", deployProvider === "netlify" && "ring-1 ring-emerald-400/60")}
                  onClick={() => void setDeployProviderMode("netlify")}
                >
                  Netlify
                </button>
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {FLOW_STEPS.map((step) => (
              <button
                key={step.id}
                className={clsx("step-tab", currentStep === step.id && "step-tab-active")}
                onClick={() => setCurrentStep(step.id)}
              >
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="text-xs text-slate-300">{step.subtitle}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_0.55fr]">
          <section className="panel min-h-[620px]">
            {currentStep === "goal" ? (
              <div className="space-y-4">
                <h2 className="panel-title">Step 1: Define Goal</h2>
                <div ref={chatRef} className="chat-scroll h-[360px] overflow-auto rounded-xl border border-emerald-500/20 bg-slate-950/60 p-3">
                  {msgs.map((m, idx) => (
                    <MessageBubble key={`${m.role}-${idx}`} role={m.role} text={m.text} />
                  ))}
                  {busy ? <MessageBubble role="assistant" text={`${busyLabel}...`} /> : null}
                </div>

                <div className="rounded-xl border border-emerald-500/20 bg-slate-950/50 p-3">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      className="h-12 flex-1 rounded-lg border border-emerald-500/25 bg-slate-900 px-3 text-sm text-emerald-50 outline-none focus:border-emerald-400"
                      value={input}
                      placeholder='Example: "Launch an AI automation agency for med spas in Miami. RUN"'
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void send();
                      }}
                      disabled={busy || killSwitch}
                    />
                    <button className="primary-btn" onClick={() => void send()} disabled={!canSend}>
                      Send
                    </button>
                    <button className="secondary-btn" onClick={() => void send(true)} disabled={!canSend}>
                      Force RUN
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-emerald-200/70">Once plan is generated, move to Step 2.</p>
                </div>

                <div className="flex justify-end">
                  <button className="primary-btn" onClick={() => setCurrentStep("plan")}>Next: Inspect Plan</button>
                </div>
              </div>
            ) : null}

            {currentStep === "plan" ? (
              <div className="space-y-4">
                <h2 className="panel-title">Step 2: Inspect Plan + Generated Assets</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <article className="subpanel">
                    <h3 className="subpanel-title">Plan</h3>
                    {plan.length === 0 ? (
                      <p className="text-sm text-slate-300">No plan yet. Return to Step 1 and submit a goal.</p>
                    ) : (
                      <ul className="space-y-2">
                        {plan.map((item) => (
                          <li key={item.id} className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-sm">
                            <p className="font-semibold text-emerald-100">{item.title}</p>
                            <p className="mono text-[11px] text-slate-400">{item.layer} / {item.status}</p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </article>

                  <article className="subpanel">
                    <h3 className="subpanel-title">Offer</h3>
                    {offer ? (
                      <div className="space-y-2 text-sm">
                        <p className="text-base font-semibold text-emerald-100">{offer.offer_name}</p>
                        <p><span className="text-emerald-200">Niche:</span> {offer.niche || "n/a"}</p>
                        <p><span className="text-emerald-200">City:</span> {offer.city || "n/a"}</p>
                        <p><span className="text-emerald-200">Value:</span> {offer.offer_value || "n/a"}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-300">No offer generated yet.</p>
                    )}
                  </article>

                  <article className="subpanel md:col-span-2">
                    <h3 className="subpanel-title">Top Leads</h3>
                    {leads.length === 0 ? (
                      <p className="text-sm text-slate-300">No leads available yet.</p>
                    ) : (
                      <div className="grid gap-2 md:grid-cols-2">
                        {leads.slice(0, 6).map((lead, idx) => (
                          <div key={`${lead.url || "lead"}-${idx}`} className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-sm">
                            <p className="font-semibold text-emerald-100">{lead.company_name || lead.title || "Untitled"}</p>
                            <p className="mono text-[11px] text-slate-400">Score: {lead.score ?? "?"}</p>
                            {lead.email ? <p className="truncate text-xs text-emerald-300/80">{lead.email}</p> : null}
                            {!lead.email && lead.contact_url ? <p className="truncate text-xs text-emerald-300/80">{lead.contact_url}</p> : null}
                            <p className="truncate text-xs text-slate-300">{lead.url}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                </div>

                <div className="flex justify-between">
                  <button className="secondary-btn" onClick={() => setCurrentStep("goal")}>Back</button>
                  <button className="primary-btn" onClick={() => setCurrentStep("execute")}>Next: Approve Actions</button>
                </div>
              </div>
            ) : null}

            {currentStep === "execute" ? (
              <div className="space-y-4">
                <h2 className="panel-title">Step 3: Approve and Execute Queue</h2>
                <p className="text-xs text-emerald-200/75">
                  First execute <span className="mono">Request laptop control permission</span>. Other OS actions stay blocked until that is completed, and each run step can trigger a native desktop popup confirmation.
                </p>
                <div className="flex flex-wrap gap-2">
                  <span className="chip">Pending: {pendingCount}</span>
                  <span className="chip">Approved: {approvedCount}</span>
                  <span className="chip">Completed: {completedCount}</span>
                  <button className="primary-btn" onClick={() => void executeApproved()} disabled={approvedCount === 0 || queueBusy || killSwitch}>
                    Execute Approved
                  </button>
                </div>

                <div className="space-y-3">
                  {queueActions.length === 0 ? (
                    <p className="text-sm text-slate-300">No queued actions yet. Run pipeline in Step 1.</p>
                  ) : (
                    queueActions.map((item) => {
                      const canApprove = item.status === "pending_approval" && !killSwitch;
                      const canExecute = item.status === "approved" && !killSwitch && !queueBusy;

                      return (
                        <article key={item.id} className="rounded-xl border border-slate-700 bg-slate-950/60 p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-semibold text-emerald-100">{item.title}</p>
                              <p className="mono text-[11px] text-slate-400">{item.layer} / {item.action_type}</p>
                            </div>
                            <StatusBadge status={item.status} />
                          </div>
                          <p className="mt-2 text-sm text-slate-300">{item.detail}</p>
                          {item.command ? <p className="mono mt-1 text-[11px] text-slate-400">{item.command}</p> : null}
                          {item.error ? <p className="mt-1 text-xs text-rose-300">{item.error}</p> : null}
                          {item.status === "completed" && item.result ? (
                            <p className="mono mt-1 truncate text-[11px] text-emerald-300/80">{JSON.stringify(item.result)}</p>
                          ) : null}

                          <div className="mt-3 flex flex-wrap gap-2">
                            <button className="secondary-btn" onClick={() => void approveAction(item.id)} disabled={!canApprove}>Approve</button>
                            <button className="secondary-btn" onClick={() => void rejectAction(item.id)} disabled={!canApprove}>Reject</button>
                            <button className="primary-btn" onClick={() => void executeAction(item.id)} disabled={!canExecute}>Execute</button>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="flex justify-between">
                  <button className="secondary-btn" onClick={() => setCurrentStep("plan")}>Back</button>
                  <button className="primary-btn" onClick={() => setCurrentStep("review")}>Next: Review Outputs</button>
                </div>
              </div>
            ) : null}

            {currentStep === "review" ? (
              <div className="space-y-4">
                <h2 className="panel-title">Step 4: Open Everything</h2>
                <div className="grid gap-4 md:grid-cols-2">
                  <article className="subpanel">
                    <h3 className="subpanel-title">Site Output</h3>
                    <p className="text-sm text-slate-300">Open the generated site preview tab.</p>
                    <button className="primary-btn mt-3" onClick={() => openPreview("site")}>Open Site Preview</button>
                  </article>

                  <article className="subpanel">
                    <h3 className="subpanel-title">Email Drafts</h3>
                    <p className="text-sm text-slate-300">Open drafts preview tab and review before manual send.</p>
                    <button className="primary-btn mt-3" onClick={() => openPreview("emails")}>Open Email Preview</button>
                  </article>

                  <article className="subpanel md:col-span-2">
                    <h3 className="subpanel-title">Full Run Report</h3>
                    <p className="text-sm text-slate-300">Open report tab with queue statuses, leads, and activity logs.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className="primary-btn" onClick={() => openPreview("report")}>Open Report</button>
                      <button className="secondary-btn" onClick={openAllPreviews}>Open All Tabs</button>
                      {artifacts?.project_dir ? (
                        <span className="mono rounded-md border border-slate-700 bg-slate-900/50 px-2 py-1 text-[11px] text-slate-400">
                          {artifacts.project_dir}
                        </span>
                      ) : null}
                    </div>
                  </article>

                  <article className="subpanel md:col-span-2">
                    <h3 className="subpanel-title">JARVIS Revision Loop</h3>
                    <p className="text-sm text-slate-300">
                      Request edits, and JARVIS will queue Lovable automation actions to apply the changes.
                    </p>
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <input
                        className="h-11 flex-1 rounded-lg border border-emerald-500/25 bg-slate-900 px-3 text-sm text-emerald-50 outline-none focus:border-emerald-400"
                        placeholder='Example: "Make headline bolder, add pricing section, and stronger CTA."'
                        value={revisionInput}
                        onChange={(e) => setRevisionInput(e.target.value)}
                      />
                      <button
                        className="primary-btn"
                        onClick={() => void queueSiteRevision()}
                        disabled={!revisionInput.trim() || revisionBusy || killSwitch}
                      >
                        {revisionBusy ? "Queueing..." : "Queue Lovable Revision"}
                      </button>
                    </div>
                  </article>

                  <article className="subpanel md:col-span-2">
                    <h3 className="subpanel-title">Raw Drafts</h3>
                    {outreach ? <pre className="h-[220px] overflow-auto text-xs">{outreach}</pre> : <p className="text-sm text-slate-300">No drafts available yet.</p>}
                  </article>
                </div>

                <div className="flex justify-between">
                  <button className="secondary-btn" onClick={() => setCurrentStep("execute")}>Back</button>
                  <button className="primary-btn" onClick={() => setCurrentStep("goal")}>Start New Run</button>
                </div>
              </div>
            ) : null}
          </section>

          <aside className="panel">
            <h2 className="panel-title">Live Status</h2>
            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
                <p className="text-emerald-100">Goal</p>
                <p className="mt-1 text-slate-300">{sessionState?.goal || "No goal captured yet."}</p>
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
                <p className="text-emerald-100">Landing Draft</p>
                {landing ? (
                  <button
                    className="secondary-btn mt-2"
                    onClick={async () => {
                      const ok = await copyToClipboard(landing);
                      setMsgs((prev) => [...prev, { role: "system", text: ok ? "Copied landing draft." : "Clipboard copy failed." }]);
                    }}
                  >
                    Copy Landing
                  </button>
                ) : (
                  <p className="mt-1 text-slate-300">Not generated yet.</p>
                )}
              </div>

              <div className="rounded-lg border border-slate-700 bg-slate-950/60 p-3">
                <p className="text-emerald-100">Recent Activity</p>
                <ul className="mt-2 space-y-2">
                  {activityLogs.slice(0, 6).map((log) => (
                    <li key={log.id} className="rounded-md border border-slate-700 bg-slate-900/60 p-2 text-xs">
                      <p className="mono text-[10px] uppercase text-slate-400">{log.event_type}</p>
                      <p className="mt-1 text-slate-200">{log.message}</p>
                    </li>
                  ))}
                  {activityLogs.length === 0 ? <li className="text-xs text-slate-400">No activity yet.</li> : null}
                </ul>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
