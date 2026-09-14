const API_BASE = "http://127.0.0.1:7788";

type PresencePayload = {
  state: string;
  mode: string;
  size: "orb" | "compact" | "expanded";
  text: string;
  active: boolean;
  manual_pause: boolean;
};

type EnqueueResponse = {
  ok: boolean;
  mode?: "needs_input" | "queued";
  summary?: string;
  question?: string;
  session_id?: string;
  actions?: Array<{
    id: string;
    description?: string;
    type?: string;
  }>;
  action?: {
    id: string;
    description?: string;
    type?: string;
  };
};

type ActionStatusResponse = {
  ok: boolean;
  action: {
    id: string;
    type: string;
    state: string;
    description?: string;
    error?: string;
    result?: {
      live_progress?: {
        phase?: string;
        step_index?: number;
        step_count?: number;
        detail?: string;
      };
      paused_reason?: string;
      resume_step_index?: number;
    };
  };
};

type OperatorStatusResponse = {
  ok: boolean;
  paused: boolean;
  running_action_id: string | null;
  running_action_type?: string | null;
};

type SettingsResponse = {
  ok: boolean;
  settings: {
    dry_run_mode?: boolean;
  };
};

const dock = document.getElementById("dock") as HTMLDivElement;
const avatarButton = document.getElementById("avatarButton") as HTMLButtonElement;
const avatarText = document.getElementById("avatarText") as HTMLParagraphElement;
const intentLine = document.getElementById("intentLine") as HTMLParagraphElement;
const modeBadge = document.getElementById("modeBadge") as HTMLSpanElement;
const sizeButton = document.getElementById("sizeButton") as HTMLButtonElement;
const resumeButton = document.getElementById("resumeButton") as HTMLButtonElement;
const chatFeed = document.getElementById("chatFeed") as HTMLDivElement;
const chatForm = document.getElementById("chatForm") as HTMLFormElement;
const chatInput = document.getElementById("chatInput") as HTMLInputElement;
const demoCursorBtn = document.getElementById("demoCursorBtn") as HTMLButtonElement;
const demoFullBtn = document.getElementById("demoFullBtn") as HTMLButtonElement;
const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement;
const SESSION_KEY = "operator-control-session-id-v1";

function getSessionId(): string {
  const fromStorage = localStorage.getItem(SESSION_KEY);
  if (fromStorage && fromStorage.trim()) return fromStorage.trim();
  const created = (globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`).slice(0, 64);
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

async function resetSession(): Promise<void> {
  const next = (globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}`).slice(0, 64);
  localStorage.setItem(SESSION_KEY, next);
  await api("/control/reset-session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: next }),
  });
}

let currentSize: "orb" | "compact" | "expanded" = "expanded";
let lastIntent = "";
let operatorPaused = false;
let manualPauseFromPresence = false;
let lastRunningControlId = "";
const trackedActions = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addLine(role: "agent" | "user", text: string): void {
  const p = document.createElement("p");
  p.className = `chat-line ${role}`;
  p.textContent = `${role === "agent" ? "Agent" : "You"}: ${text}`;
  chatFeed.prepend(p);
  while (chatFeed.childElementCount > 40) {
    chatFeed.removeChild(chatFeed.lastElementChild as ChildNode);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status}: ${txt}`);
  }
  return await res.json() as T;
}

function updatePauseUi(): void {
  if (operatorPaused) {
    modeBadge.textContent = "Paused";
    resumeButton.classList.remove("hidden");
    return;
  }
  if (manualPauseFromPresence) {
    modeBadge.textContent = "Paused for You";
    resumeButton.classList.remove("hidden");
    return;
  }
  modeBadge.textContent = "Autonomous";
  resumeButton.classList.add("hidden");
}

async function setSize(size: "orb" | "compact" | "expanded"): Promise<void> {
  currentSize = size;
  dock.className = `dock size-${size}`;
  sizeButton.textContent = size === "expanded" ? "Orb" : size === "compact" ? "Expand" : "Compact";
  if (window.desktopBridge?.setPresenceSize) {
    await window.desktopBridge.setPresenceSize(size);
  }
}

function nextSize(size: "orb" | "compact" | "expanded"): "orb" | "compact" | "expanded" {
  if (size === "orb") return "compact";
  if (size === "compact") return "expanded";
  return "orb";
}

function applyPresence(payload: PresencePayload): void {
  const state = String(payload.state || "idle");
  avatarButton.className = `avatar state-${state}`;
  avatarText.textContent = String(payload.text || "Standing by");
  manualPauseFromPresence = Boolean(payload.manual_pause);
  updatePauseUi();

  if (payload.size && payload.size !== currentSize) {
    void setSize(payload.size);
  }
}

async function postInteraction(kind: string, detail: string, active?: boolean): Promise<void> {
  await api("/cognition/interaction", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, detail, active }),
  });
}

async function resumeAutonomy(): Promise<void> {
  if (window.desktopBridge?.resumeAfterInput) {
    await window.desktopBridge.resumeAfterInput();
  } else {
    await api("/operator/resume", { method: "POST" });
  }
  await postInteraction("resume", "avatar_resume", true).catch(() => {
    // noop
  });
  operatorPaused = false;
  updatePauseUi();
  addLine("agent", "Autonomy resumed.");
}

async function pauseAutonomy(): Promise<void> {
  await api("/operator/pause", { method: "POST" });
  await postInteraction("pause", "avatar_pause", true).catch(() => {
    // noop
  });
  operatorPaused = true;
  updatePauseUi();
  addLine("agent", "Paused. Press Resume when ready.");
}

async function watchAction(actionId: string, label: string): Promise<void> {
  if (!actionId || trackedActions.has(actionId)) return;
  trackedActions.add(actionId);
  let lastProgressKey = "";
  try {
    for (let i = 0; i < 220; i += 1) {
      const status = await api<ActionStatusResponse>(`/action/${encodeURIComponent(actionId)}`);
      const state = String(status.action.state || "");
      if (state === "RUNNING") {
        const progress = status.action.result?.live_progress;
        const stepIndex = Number(progress?.step_index ?? 0);
        const stepCount = Number(progress?.step_count ?? 0);
        const detail = String(progress?.detail ?? "").trim();
        const key = `${stepIndex}:${stepCount}:${detail}`;
        if (detail && key !== lastProgressKey) {
          lastProgressKey = key;
          if (stepCount > 0 && stepIndex > 0) addLine("agent", `${label} - Step ${stepIndex}/${stepCount}: ${detail}`);
          else addLine("agent", `${label} - ${detail}`);
        }
      }
      if (state === "QUEUED") {
        const pausedReason = String(status.action.result?.paused_reason ?? "");
        const resumeStep = Number(status.action.result?.resume_step_index ?? NaN);
        if (pausedReason === "login_required") {
          const suffix = Number.isFinite(resumeStep) ? ` (will resume at step ${Math.floor(resumeStep) + 1})` : "";
          addLine("agent", `${label} paused for login handoff${suffix}. Complete sign-in, then press Resume.`);
          return;
        }
        if (pausedReason === "manual_pause") {
          addLine("agent", `${label} paused. Press Resume to continue.`);
          return;
        }
      }
      if (state === "SUCCESS") {
        addLine("agent", `${label} completed.`);
        return;
      }
      if (state === "FAILED" || state === "CANCELED") {
        const err = status.action.error ? ` ${status.action.error}` : "";
        addLine("agent", `${label} ${state.toLowerCase()}.${err}`.trim());
        return;
      }
      await sleep(450);
    }
    addLine("agent", `${label} still running. Ask: what are you doing?`);
  } catch (error) {
    addLine("agent", `Could not read action status: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    trackedActions.delete(actionId);
  }
}

async function runDemo(scenario: "cursor" | "full" | "smoke"): Promise<void> {
  const response = await api<EnqueueResponse>("/demo/os-control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      scenario: scenario === "cursor" ? "cursor" : scenario === "smoke" ? "smoke" : "full",
      text: scenario === "smoke" ? "OS smoke test running." : "OS control confirmed in real time.",
      duration_ms: scenario === "cursor" ? 2200 : scenario === "smoke" ? 5200 : 4200,
      interrupt_current: true,
    }),
  });
  const label = scenario === "cursor"
    ? "Running cursor control test."
    : scenario === "smoke"
      ? "Running deterministic OS smoke test."
      : "Running full OS control test.";
  addLine("agent", label);
  if (response.action?.id) {
    void watchAction(response.action.id, "Control test");
  }
}

async function runDirectControl(objective: string): Promise<void> {
  const response = await api<EnqueueResponse>("/control/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      objective,
      dry_run: false,
      interrupt_current: true,
      session_id: getSessionId(),
    }),
  });

  if (response.mode === "needs_input") {
    if (response.summary) addLine("agent", response.summary);
    addLine("agent", response.question || "I need one more detail before acting.");
    return;
  }

  addLine("agent", response.summary || "Executing with direct keyboard/cursor control.");

  const queuedActions = Array.isArray(response.actions) ? response.actions : [];
  if (queuedActions.length > 0) {
    addLine("agent", `Plan ready: ${queuedActions.length} action${queuedActions.length === 1 ? "" : "s"}. Executing step-by-step.`);
    for (const action of queuedActions) {
      if (action.id) void watchAction(action.id, action.description || "Control action");
    }
    return;
  }

  if (response.action?.id) {
    void watchAction(response.action.id, response.action.description || "Control action");
  }
}

async function submitInput(raw: string): Promise<void> {
  const text = raw.trim();
  if (!text) return;
  const normalized = text.toLowerCase();
  addLine("user", text);

  if (normalized === "resume") {
    await resumeAutonomy();
    return;
  }
  if (normalized === "pause") {
    await pauseAutonomy();
    return;
  }
  if (normalized === "what are you doing" || normalized === "what are you doing?") {
    const state = await api<{ ok: boolean; state: { current_intent: string; micro_thought: string } }>("/cognition/state");
    const line = `${state.state.current_intent}${state.state.micro_thought ? ` - ${state.state.micro_thought}` : ""}`;
    addLine("agent", line);
    return;
  }
  if (normalized === "reset" || normalized === "start over" || normalized === "new task") {
    await resetSession();
    addLine("agent", "Session reset. Tell me the next objective.");
    return;
  }
  if (normalized === "test control" || normalized === "test os") {
    await runDemo("full");
    return;
  }
  if (normalized === "test smoke") {
    await runDemo("smoke");
    return;
  }
  if (normalized === "test cursor") {
    await runDemo("cursor");
    return;
  }
  if (normalized === "what do you see" || normalized === "look at screen" || normalized === "analyze screen") {
    try {
      const payload = await api<{
        ok: boolean;
        analysis?: string;
        model?: string;
      }>("/vision/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Describe the visible screen and identify the best next actionable UI step.",
        }),
      });
      const model = payload.model ? ` (${payload.model})` : "";
      const analysis = String(payload.analysis || "").trim();
      addLine("agent", analysis ? `Vision${model}: ${analysis}` : "Vision response was empty.");
    } catch (error) {
      addLine("agent", `Vision failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (normalized.startsWith("/goal ")) {
    const objective = text.slice(6).trim();
    if (!objective) return;
    await api("/cognition/goal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective }),
    });
    await postInteraction("manual_input", objective, true).catch(() => {
      // noop
    });
    addLine("agent", "Objective updated in cognition runtime.");
    return;
  }

  await runDirectControl(text);
  await postInteraction("manual_input", text, true).catch(() => {
    // noop
  });
}

async function pollIntent(): Promise<void> {
  try {
    const payload = await api<{ ok: boolean; state: { current_intent: string; micro_thought: string; objective: string } }>("/cognition/state");
    const current = String(payload.state.current_intent || "Monitoring system");
    const micro = String(payload.state.micro_thought || "");
    intentLine.textContent = micro ? `${current} - ${micro}` : current;
    if (current !== lastIntent) {
      lastIntent = current;
      addLine("agent", current);
    }
  } catch {
    // noop
  }
}

async function pollOperatorStatus(): Promise<void> {
  try {
    const payload = await api<OperatorStatusResponse>("/operator/status");
    const wasPaused = operatorPaused;
    operatorPaused = Boolean(payload.paused);
    updatePauseUi();

    if (operatorPaused && !wasPaused) {
      addLine("agent", "Operator is paused. Press Resume.");
    }

    const runningId = String(payload.running_action_id || "");
    const runningType = String(payload.running_action_type || "");
    if (runningId && runningId !== lastRunningControlId && (runningType === "OS_INPUT_CONTROL" || runningType === "OS_DEMO_CONTROL")) {
      lastRunningControlId = runningId;
      void watchAction(runningId, "Control action");
    }
    if (!runningId) {
      lastRunningControlId = "";
    }
  } catch {
    // noop
  }
}

async function checkSettings(): Promise<void> {
  try {
    const settings = await api<SettingsResponse>("/settings");
    if (settings.settings?.dry_run_mode) {
      addLine("agent", "Dry-run mode is enabled. Live OS control is disabled until turned off.");
    }
  } catch {
    // noop
  }
}

avatarButton.onclick = async () => {
  await setSize(nextSize(currentSize));
};

avatarButton.oncontextmenu = async (event) => {
  event.preventDefault();
  if (window.desktopBridge?.togglePresenceMode) {
    await window.desktopBridge.togglePresenceMode();
  }
};

sizeButton.onclick = async () => {
  await setSize(nextSize(currentSize));
};

resumeButton.onclick = async () => {
  await resumeAutonomy();
};

pauseBtn.onclick = async () => {
  await pauseAutonomy();
};

demoCursorBtn.onclick = async () => {
  await runDemo("cursor");
};

demoFullBtn.onclick = async () => {
  await runDemo("full");
};

chatForm.onsubmit = async (event) => {
  event.preventDefault();
  const text = chatInput.value;
  chatInput.value = "";
  try {
    await submitInput(text);
  } catch (error) {
    addLine("agent", `Execution failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

window.desktopBridge?.onPresenceData?.((payload) => {
  applyPresence(payload as PresencePayload);
});

addLine("agent", "Avatar control ready. Type an action, `test cursor`, or `test smoke`.");
void setSize(currentSize);
void checkSettings();
void pollIntent();
void pollOperatorStatus();
setInterval(() => {
  void pollIntent();
}, 2200);
setInterval(() => {
  void pollOperatorStatus();
}, 1200);

export {};
