const API_BASE = "http://127.0.0.1:7788";

type QueueAction = {
  id: string;
  run_id: string;
  type: string;
  description: string;
  state: string;
  risk_level: string;
  required_permissions?: string[];
  inputs?: Record<string, unknown>;
  error?: string;
  created_at?: string;
};

type Settings = {
  approval_mode: boolean;
  desktop_popups: boolean;
  browser_automation_mode: "browser";
  workspace_root: string;
  provider: "vercel" | "netlify";
  dry_run_mode: boolean;
  control_mode: "assistive" | "operator";
  voice_mode: boolean;
  focus_mode: boolean;
  memory_notes: string;
};

type DeviceRegisterResp = {
  ok: boolean;
  device: { device_name: string };
};

type DefaultPairingResp = {
  ok: boolean;
  pairing_code: string;
};

type AuthBootstrapResp = {
  ok: boolean;
  providers: Record<string, string>;
  message?: string;
};

type PipelineResp = {
  ok: boolean;
  run_id: string;
  project_slug: string;
  queued_actions: number;
};

type LeadSeed = {
  company_name?: string;
  email?: string;
  url?: string;
};

type LeadModeResp = PipelineResp;

type CognitionIntent = {
  id: string;
  intent: string;
  micro_thought?: string;
  status: "running" | "completed" | "blocked" | "failed";
  created_at: string;
};

type CognitionSnapshot = {
  state: {
    objective: string;
    current_intent: string;
    micro_thought: string;
    phase: string;
    autonomy_behavior: string;
    recent_intents: CognitionIntent[];
  };
};

const queueBody = document.getElementById("queueBody") as HTMLTableSectionElement;
const logsOutput = document.getElementById("logsOutput") as HTMLPreElement;
const runsList = document.getElementById("runsList") as HTMLUListElement;
const healthChip = document.getElementById("healthChip") as HTMLSpanElement;
const timelineList = document.getElementById("timelineList") as HTMLUListElement;
const intentStream = document.getElementById("intentStream") as HTMLUListElement;

const approvalModeInput = document.getElementById("approvalMode") as HTMLInputElement;
const desktopPopupsInput = document.getElementById("desktopPopups") as HTMLInputElement;
const browserModeSelect = document.getElementById("browserMode") as HTMLSelectElement;
const providerSelect = document.getElementById("providerSelect") as HTMLSelectElement;
const workspaceRootInput = document.getElementById("workspaceRoot") as HTMLInputElement;
const controlModeSelect = document.getElementById("controlModeSelect") as HTMLSelectElement;
const dryRunToggle = document.getElementById("dryRunToggle") as HTMLInputElement;
const voiceModeToggle = document.getElementById("voiceModeToggle") as HTMLInputElement;
const focusModeToggle = document.getElementById("focusModeToggle") as HTMLInputElement;

const pairCodeInput = document.getElementById("pairingCodeInput") as HTMLInputElement;
const deviceNameInput = document.getElementById("deviceNameInput") as HTMLInputElement;
const pairStatus = document.getElementById("pairStatus") as HTMLSpanElement;

const agentStatusLine = document.getElementById("agentStatusLine") as HTMLParagraphElement;
const agentTypingLine = document.getElementById("agentTypingLine") as HTMLParagraphElement;

const chatMessages = document.getElementById("chatMessages") as HTMLDivElement;
const chatInput = document.getElementById("chatInput") as HTMLInputElement;
const leadCsvInput = document.getElementById("leadCsvInput") as HTMLInputElement;
const leadListInput = document.getElementById("leadListInput") as HTMLTextAreaElement;

const approvalModal = document.getElementById("approvalModal") as HTMLDivElement;
const approvalTitle = document.getElementById("approvalTitle") as HTMLHeadingElement;
const approvalMeta = document.getElementById("approvalMeta") as HTMLParagraphElement;
const approvalInputs = document.getElementById("approvalInputs") as HTMLPreElement;
const modalApproveBtn = document.getElementById("modalApproveBtn") as HTMLButtonElement;
const modalAllowSessionBtn = document.getElementById("modalAllowSessionBtn") as HTMLButtonElement;
const modalAllowAlwaysBtn = document.getElementById("modalAllowAlwaysBtn") as HTMLButtonElement;
const modalRejectBtn = document.getElementById("modalRejectBtn") as HTMLButtonElement;
const modalLaterBtn = document.getElementById("modalLaterBtn") as HTMLButtonElement;

let latestQueue: QueueAction[] = [];
const popupDismissed = new Set<string>();
let popupActionId: string | null = null;
let autoPairingDone = false;
let autoPairingTimer: number | null = null;
let authBootstrapDone = false;
let lastGoal = "Start an AI automation business for dentists in Austin";
const typingQueue: string[] = [];
let typingTimer: number | null = null;
let lastIntentLine = "";

function setPresence(payload: { state?: string; mode?: string; text?: string; active?: boolean }): void {
  window.desktopBridge?.setPresence?.(payload);
}

function speakLine(text: string): void {
  if (!voiceModeToggle.checked || !("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.03;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function chat(role: "agent" | "user", text: string, speak = false): void {
  const p = document.createElement("p");
  p.className = `chat-line ${role}`;
  p.textContent = `${role === "agent" ? "Agent" : "You"}: ${text}`;
  chatMessages.appendChild(p);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  while (chatMessages.childElementCount > 90) {
    chatMessages.removeChild(chatMessages.firstElementChild as Element);
  }
  if (speak && role === "agent") speakLine(text);
}

function queueTyping(line: string): void {
  const cleaned = String(line || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  typingQueue.push(cleaned.slice(0, 120));
  if (typingQueue.length > 10) typingQueue.shift();
  pumpTyping();
}

function pumpTyping(): void {
  if (typingTimer !== null) return;
  const next = typingQueue.shift();
  if (!next) return;
  let cursor = 0;
  agentTypingLine.textContent = "";
  typingTimer = window.setInterval(() => {
    cursor += 1;
    agentTypingLine.textContent = next.slice(0, cursor);
    if (cursor >= next.length) {
      if (typingTimer !== null) {
        window.clearInterval(typingTimer);
        typingTimer = null;
      }
      window.setTimeout(pumpTyping, 280);
    }
  }, 12);
}

function logLine(line: string): void {
  const stamp = new Date().toLocaleTimeString();
  logsOutput.textContent = `[${stamp}] ${line}\n${logsOutput.textContent}`.slice(0, 18000);
  queueTyping(line);
}

function setAgentStatus(text: string, state: "idle" | "thinking" | "working" | "permission" | "success" | "error" | "background" = "idle"): void {
  agentStatusLine.textContent = text;
  setPresence({ text, state, active: true });
}

function appendIntentLine(text: string, status: "running" | "completed" | "blocked" | "failed" = "running"): void {
  if (!text || text === lastIntentLine) return;
  lastIntentLine = text;
  const li = document.createElement("li");
  li.textContent = text;
  if (status === "running") li.className = "running";
  if (status === "completed") li.className = "done";
  if (status === "blocked" || status === "failed") li.className = "blocked";
  intentStream.prepend(li);
  while (intentStream.childElementCount > 14) {
    intentStream.removeChild(intentStream.lastElementChild as ChildNode);
  }
}

function applyCognitionState(snapshot: CognitionSnapshot): void {
  const state = snapshot.state;
  const objective = String(state.objective ?? "Awaiting objective");
  const intent = String(state.current_intent ?? "Monitoring context");
  const micro = String(state.micro_thought ?? "");
  setAgentStatus(`${objective}`, "working");
  queueTyping(intent);
  if (micro) appendIntentLine(`${intent} — ${micro}`, "running");
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`${res.status}: ${txt}`);
  }
  return (await res.json()) as T;
}

function getMemoryNotes(): string {
  return localStorage.getItem("operator_memory_notes") ?? "";
}

function setMemoryNotes(notes: string): void {
  localStorage.setItem("operator_memory_notes", notes);
}

async function decideAction(actionId: string, decision: "approve" | "reject"): Promise<void> {
  await fetchJson(`${API_BASE}/action/${decision}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: actionId }),
  });
}

async function grantPermissions(permissions: string[], scope: "session" | "always"): Promise<void> {
  await fetchJson(`${API_BASE}/permissions/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissions, scope }),
  });
}
function renderTimeline(actions: QueueAction[]): void {
  timelineList.innerHTML = "";
  const sorted = actions.slice().sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  for (const action of sorted.slice(-18)) {
    const li = document.createElement("li");
    li.textContent = `${action.type} - ${action.state}`;
    if (action.state === "RUNNING") li.className = "running";
    else if (action.state === "SUCCESS") li.className = "done";
    else if (action.state === "AWAITING_APPROVAL") li.className = "blocked";
    timelineList.appendChild(li);
  }
}

function renderRuns(actions: QueueAction[]): void {
  const grouped = new Map<string, QueueAction[]>();
  for (const action of actions) {
    const arr = grouped.get(action.run_id) ?? [];
    arr.push(action);
    grouped.set(action.run_id, arr);
  }

  runsList.innerHTML = "";
  for (const [runId, items] of grouped.entries()) {
    const li = document.createElement("li");
    const done = items.filter((item) => item.state === "SUCCESS").length;
    li.innerHTML = `<strong>${runId}</strong><br />${done}/${items.length} complete`;
    runsList.appendChild(li);
  }
}

function formatInputs(inputs?: Record<string, unknown>): string {
  if (!inputs || Object.keys(inputs).length === 0) return "No input payload.";
  const text = JSON.stringify(inputs, null, 2);
  return text.length > 2200 ? `${text.slice(0, 2200)}\n...` : text;
}

function closeApprovalModal(): void {
  popupActionId = null;
  approvalModal.classList.add("hidden");
  approvalModal.setAttribute("aria-hidden", "true");
}

function openApprovalModal(action: QueueAction): void {
  popupActionId = action.id;
  const perms = (action.required_permissions ?? []).join(", ") || "none";
  approvalTitle.textContent = `AI wants to: ${action.description}`;
  approvalMeta.textContent = `Risk: ${action.risk_level} | Needs: ${perms}`;
  approvalInputs.textContent = formatInputs(action.inputs);
  approvalModal.classList.remove("hidden");
  approvalModal.setAttribute("aria-hidden", "false");
}

function refreshPermissionPopup(): void {
  for (const id of Array.from(popupDismissed)) {
    const action = latestQueue.find((item) => item.id === id);
    if (!action || action.state !== "AWAITING_APPROVAL") popupDismissed.delete(id);
  }

  if (!desktopPopupsInput.checked) {
    closeApprovalModal();
    return;
  }

  if (popupActionId) {
    const current = latestQueue.find((item) => item.id === popupActionId && item.state === "AWAITING_APPROVAL");
    if (!current) closeApprovalModal();
  }
  if (popupActionId) return;

  const next = latestQueue
    .slice()
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .find((item) => item.state === "AWAITING_APPROVAL" && !popupDismissed.has(item.id));
  if (next) openApprovalModal(next);
}

function renderQueue(actions: QueueAction[]): void {
  latestQueue = actions;
  renderTimeline(actions);

  const running = actions.find((item) => item.state === "RUNNING");
  const waiting = actions.filter((item) => item.state === "AWAITING_APPROVAL").length;
  const queued = actions.filter((item) => item.state === "QUEUED").length;
  if (running) setAgentStatus(`Working on ${running.type}`, "working");
  else if (waiting > 0) setAgentStatus(`Waiting for permission (${waiting})`, "permission");
  else if (queued > 0) setAgentStatus(`Queued tasks ready (${queued})`, "thinking");
  else setAgentStatus("Standing by...", "idle");

  queueBody.innerHTML = "";
  for (const action of actions) {
    const tr = document.createElement("tr");
    const runTd = document.createElement("td");
    const descTd = document.createElement("td");
    const stateTd = document.createElement("td");
    const riskTd = document.createElement("td");
    const controlsTd = document.createElement("td");

    runTd.textContent = action.run_id.slice(0, 8);
    stateTd.textContent = action.state;
    riskTd.textContent = action.risk_level;

    const primary = document.createElement("div");
    primary.textContent = action.description;
    const typeLabel = document.createElement("div");
    typeLabel.style.color = "#93d9b3";
    typeLabel.textContent = action.type;
    descTd.append(primary, typeLabel);
    if (action.error) {
      const err = document.createElement("div");
      err.style.color = "#ff9bb0";
      err.textContent = action.error;
      descTd.appendChild(err);
    }

    if (action.state === "AWAITING_APPROVAL") {
      const approveBtn = document.createElement("button");
      approveBtn.textContent = "Allow Once";
      approveBtn.onclick = async () => {
        await decideAction(action.id, "approve");
        popupDismissed.add(action.id);
        if (popupActionId === action.id) closeApprovalModal();
        await refreshQueue();
      };

      const denyBtn = document.createElement("button");
      denyBtn.textContent = "Deny";
      denyBtn.onclick = async () => {
        await decideAction(action.id, "reject");
        popupDismissed.add(action.id);
        if (popupActionId === action.id) closeApprovalModal();
        await refreshQueue();
      };

      controlsTd.append(approveBtn, denyBtn);
    } else {
      controlsTd.textContent = "-";
    }

    tr.append(runTd, descTd, stateTd, riskTd, controlsTd);
    queueBody.appendChild(tr);
  }

  refreshPermissionPopup();
}

async function refreshHealth(): Promise<void> {
  try {
    const health = await fetchJson<{ ok: boolean }>(`${API_BASE}/health`);
    healthChip.textContent = health.ok ? "health: online" : "health: degraded";
  } catch {
    healthChip.textContent = "health: offline";
    setAgentStatus("Waiting for local agent...", "error");
  }
}

async function refreshSettings(): Promise<void> {
  const payload = await fetchJson<{ ok: boolean; settings: Settings }>(`${API_BASE}/settings`);
  const s = payload.settings;
  approvalModeInput.checked = s.approval_mode;
  desktopPopupsInput.checked = s.desktop_popups;
  browserModeSelect.value = s.browser_automation_mode;
  providerSelect.value = s.provider;
  workspaceRootInput.value = s.workspace_root;
  controlModeSelect.value = s.control_mode;
  dryRunToggle.checked = Boolean(s.dry_run_mode);
  voiceModeToggle.checked = Boolean(s.voice_mode);
  focusModeToggle.checked = Boolean(s.focus_mode);
  if (s.memory_notes) setMemoryNotes(s.memory_notes);
  setPresence({ mode: focusModeToggle.checked ? "glow" : "orb" });
}

async function saveSettings(): Promise<void> {
  await fetchJson(`${API_BASE}/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approval_mode: approvalModeInput.checked,
      desktop_popups: desktopPopupsInput.checked,
      browser_automation_mode: browserModeSelect.value,
      provider: providerSelect.value,
      workspace_root: workspaceRootInput.value.trim(),
      control_mode: controlModeSelect.value,
      dry_run_mode: dryRunToggle.checked,
      voice_mode: voiceModeToggle.checked,
      focus_mode: focusModeToggle.checked,
      memory_notes: getMemoryNotes(),
    }),
  });
  setPresence({ mode: focusModeToggle.checked ? "glow" : "orb" });
  logLine("Settings updated.");
  await refreshQueue();
}

async function refreshQueue(): Promise<void> {
  const payload = await fetchJson<{ ok: boolean; actions: QueueAction[] }>(`${API_BASE}/queue/status`);
  renderQueue(payload.actions);
  renderRuns(payload.actions);
}

async function refreshCognitionState(): Promise<void> {
  const payload = await fetchJson<{ ok: boolean; state: CognitionSnapshot["state"] }>(`${API_BASE}/cognition/state`);
  applyCognitionState({ state: payload.state });
}

async function sendInteraction(kind: string, detail: string, active?: boolean): Promise<void> {
  await fetchJson(`${API_BASE}/cognition/interaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, detail, active }),
  });
}

async function setObjective(objective: string): Promise<void> {
  const text = objective.trim();
  if (text.length < 3) return;
  await fetchJson(`${API_BASE}/cognition/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ objective: text }),
  });
  await sendInteraction("manual_input", text, true);
  chat("agent", `Objective updated: ${text}`, true);
}

async function getDefaultPairingCode(): Promise<string> {
  const payload = await fetchJson<DefaultPairingResp>(`${API_BASE}/device/default-pairing`);
  return String(payload.pairing_code ?? "").trim();
}

function preferredDeviceName(): string {
  return deviceNameInput.value.trim() || "Operator Assist Desktop";
}

async function registerDeviceWithCode(pairingCode: string): Promise<DeviceRegisterResp> {
  return fetchJson<DeviceRegisterResp>(`${API_BASE}/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode, device_name: preferredDeviceName() }),
  });
}

async function registerDevice(): Promise<void> {
  let pairingCode = pairCodeInput.value.trim();
  if (!pairingCode) {
    pairingCode = await getDefaultPairingCode();
    pairCodeInput.value = pairingCode;
  }
  if (!pairingCode) {
    pairStatus.textContent = "Pairing code required.";
    return;
  }
  const result = await registerDeviceWithCode(pairingCode);
  autoPairingDone = true;
  pairStatus.textContent = result.ok ? `Connected as ${result.device.device_name}` : "Failed to connect";
  if (result.ok) setAgentStatus("Device paired.", "success");
}
async function autoPairDevice(): Promise<void> {
  if (autoPairingDone) return;
  const pairingCode = await getDefaultPairingCode();
  if (!pairingCode) return;
  pairCodeInput.value = pairingCode;
  const result = await registerDeviceWithCode(pairingCode);
  if (!result.ok) return;
  autoPairingDone = true;
  pairStatus.textContent = `Auto-connected as ${result.device.device_name}`;
  logLine(`Auto-paired device with code ${pairingCode}`);
  setAgentStatus("Auto-paired and ready.", "success");
  if (autoPairingTimer !== null) {
    window.clearInterval(autoPairingTimer);
    autoPairingTimer = null;
  }
}

function startAutoPairing(): void {
  const tick = async () => {
    try {
      await autoPairDevice();
    } catch (error) {
      logLine(`Auto pairing retrying: ${String(error)}`);
    }
  };
  void tick();
  if (autoPairingTimer !== null) return;
  autoPairingTimer = window.setInterval(() => {
    void tick();
  }, 3000);
}

async function bootstrapAuth(silent = false): Promise<void> {
  const result = await fetchJson<AuthBootstrapResp>(`${API_BASE}/auth/bootstrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: ["gmail", "lovable"] }),
  });
  const status = Object.entries(result.providers ?? {}).map(([name, state]) => `${name}:${state}`).join(", ");
  setAgentStatus(`Auth ${status}`, status.includes("login_required") ? "permission" : "success");
  if (!silent) {
    chat("agent", `Auth check complete: ${status}`, true);
    if (result.message) logLine(result.message);
  }
}

function goalSeed(kind: "start" | "grow" | "explore"): string {
  if (kind === "start") return "Start an AI automation business for dentists in Austin";
  if (kind === "grow") return "Grow an existing roofing company with AI lead qualification in Phoenix";
  return "Explore operator capabilities with a sample business launch workflow";
}

function dedupeLeads(leads: LeadSeed[]): LeadSeed[] {
  const seen = new Set<string>();
  const unique: LeadSeed[] = [];
  for (const lead of leads) {
    const company = String(lead.company_name ?? "").trim().toLowerCase();
    const email = String(lead.email ?? "").trim().toLowerCase();
    const url = String(lead.url ?? "").trim().toLowerCase();
    if (!company && !email && !url) continue;
    const key = `${company}|${email}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      company_name: company || undefined,
      email: email || undefined,
      url: url || undefined,
    });
  }
  return unique;
}

function parseManualLeadList(text: string): LeadSeed[] {
  const lines = text
    .split(/\r?\n|,/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: LeadSeed[] = [];
  for (const line of lines) {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)) {
      parsed.push({ email: line });
      continue;
    }
    if (/\./.test(line) || /^https?:\/\//i.test(line)) {
      parsed.push({ url: line });
      continue;
    }
    parsed.push({ company_name: line });
  }

  return dedupeLeads(parsed);
}

function parseCsvLeads(csv: string): LeadSeed[] {
  const rows = csv
    .split(/\r?\n/g)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.length === 0) return [];

  const first = rows[0].toLowerCase();
  const hasHeader = first.includes("email") || first.includes("url") || first.includes("website") || first.includes("company");
  const header = hasHeader
    ? rows[0].split(",").map((cell) => cell.trim().toLowerCase())
    : ["value"];
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const leads: LeadSeed[] = [];
  for (const row of dataRows) {
    const cols = row.split(",").map((cell) => cell.trim());
    const lead: LeadSeed = {};

    for (let idx = 0; idx < cols.length; idx += 1) {
      const key = header[idx] ?? `col_${idx}`;
      const value = cols[idx];
      if (!value) continue;
      if (key.includes("email")) lead.email = value;
      else if (key.includes("url") || key.includes("site") || key.includes("website") || key === "value") lead.url = value;
      else if (key.includes("company") || key.includes("name")) lead.company_name = value;
    }

    if (!lead.company_name && !lead.email && !lead.url && cols[0]) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cols[0])) lead.email = cols[0];
      else lead.url = cols[0];
    }
    leads.push(lead);
  }

  return dedupeLeads(leads);
}

async function collectLeadModeInput(): Promise<LeadSeed[]> {
  const manual = parseManualLeadList(leadListInput.value);
  let csvLeads: LeadSeed[] = [];
  const file = leadCsvInput.files?.[0];
  if (file) {
    const text = await file.text();
    csvLeads = parseCsvLeads(text);
  }
  return dedupeLeads([...csvLeads, ...manual]);
}

async function createRunFromGoal(goal: string): Promise<void> {
  const text = goal.trim();
  if (text.length < 6) {
    chat("agent", "Please give me a fuller goal.", true);
    return;
  }
  lastGoal = text;
  setAgentStatus("Rebuilding goal graph...", "thinking");
  await setObjective(text);
  await refreshCognitionState();
}

async function runLeadMode(goal: string, leads: LeadSeed[]): Promise<void> {
  if (leads.length === 0) {
    chat("agent", "Lead Mode needs at least one lead (CSV or pasted sites/emails).", true);
    return;
  }

  setAgentStatus(`Lead Mode: preparing ${leads.length} leads...`, "thinking");
  const result = await fetchJson<LeadModeResp>(`${API_BASE}/pipeline/lead-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      goal,
      provider: providerSelect.value,
      workspace_root: workspaceRootInput.value.trim(),
      leads,
    }),
  });
  chat("agent", `Lead Mode queued run ${result.run_id.slice(0, 8)} with ${result.queued_actions} steps.`, true);
  setAgentStatus("Lead Mode queued.", "working");
  await refreshQueue();
}

function actionSummary(): string {
  const latestIntent = intentStream.firstElementChild?.textContent?.trim();
  if (latestIntent) return latestIntent;
  const running = latestQueue.find((item) => item.state === "RUNNING");
  if (running) return `I am working on ${running.type}.`;
  const waiting = latestQueue.filter((item) => item.state === "AWAITING_APPROVAL").length;
  if (waiting > 0) return `I need permission for ${waiting} action(s).`;
  const queued = latestQueue.filter((item) => item.state === "QUEUED").length;
  if (queued > 0) return `I have ${queued} queued action(s).`;
  return "I am idle and ready.";
}

async function pauseOperator(): Promise<void> {
  await fetchJson(`${API_BASE}/operator/pause`, { method: "POST" });
  await sendInteraction("pause", "pause command", true);
  setAgentStatus("Paused by user.", "background");
  chat("agent", "Paused. Say Resume when ready.", true);
}

async function resumeOperator(): Promise<void> {
  await fetchJson(`${API_BASE}/operator/resume`, { method: "POST" });
  await sendInteraction("resume", "resume command", true);
  setAgentStatus("Resumed.", "working");
  chat("agent", "Resumed execution.", true);
}

async function approveAll(): Promise<void> {
  const waiting = latestQueue.filter((item) => item.state === "AWAITING_APPROVAL");
  for (const action of waiting) {
    await decideAction(action.id, "approve");
  }
  chat("agent", `Approved ${waiting.length} action(s).`);
  await refreshQueue();
}

async function handleCommand(raw: string): Promise<void> {
  const text = raw.trim();
  if (!text) return;
  const normalized = text.toLowerCase();
  chat("user", text);
  await sendInteraction("manual_input", text, true).catch(() => {
    // noop
  });

  if (normalized === "pause") return pauseOperator();
  if (normalized === "resume") return resumeOperator();
  if (normalized === "what are you doing" || normalized === "what are you doing?") {
    chat("agent", actionSummary(), true);
    return;
  }
  if (normalized === "undo" || normalized === "undo that") {
    await fetchJson(`${API_BASE}/kill`, { method: "POST" });
    chat("agent", "Stopped active execution safely.", true);
    setAgentStatus("Interrupted.", "error");
    await refreshQueue();
    return;
  }
  if (normalized === "approve all") return approveAll();
  if (normalized === "test control" || normalized === "test os control") {
    await fetchJson(`${API_BASE}/demo/os-control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario: "full", text: "OS control demo from chat.", duration_ms: 3800 }),
    });
    chat("agent", "Started OS control demo.");
    return;
  }
  if (normalized === "start a business") return createRunFromGoal(goalSeed("start"));
  if (normalized === "grow an existing business") return createRunFromGoal(goalSeed("grow"));
  if (normalized === "just explore") return createRunFromGoal(goalSeed("explore"));
  if (normalized === "regenerate") return createRunFromGoal(lastGoal);
  if (normalized.startsWith("lead mode")) {
    const leadText = text.replace(/^lead mode[:\s-]*/i, "").trim();
    const parsed = parseManualLeadList(leadText);
    if (parsed.length === 0) {
      chat("agent", "Add leads after 'lead mode' or use the CSV/textarea block, then click Run Lead Mode.", true);
      return;
    }
    await runLeadMode("Generate personalized outreach for provided leads", parsed);
    return;
  }

  if (normalized.startsWith("remember ")) {
    const note = text.replace(/^remember\s+/i, "").trim();
    if (note) {
      const current = getMemoryNotes();
      setMemoryNotes(current ? `${current}\n- ${note}` : `- ${note}`);
      await saveSettings();
      chat("agent", "Saved that to memory.", true);
    }
    return;
  }

  if (text.length > 8) {
    await createRunFromGoal(text);
    return;
  }

  chat("agent", "Try: Pause, Resume, What are you doing?, or describe your business goal.", true);
}

function bindEvents(): void {
  const killButton = document.getElementById("killButton") as HTMLButtonElement;
  const saveSettingsBtn = document.getElementById("saveSettingsBtn") as HTMLButtonElement;
  const refreshQueueBtn = document.getElementById("refreshQueueBtn") as HTMLButtonElement;
  const registerDeviceBtn = document.getElementById("registerDeviceBtn") as HTMLButtonElement;
  const startAgentBtn = document.getElementById("startAgentBtn") as HTMLButtonElement;
  const stopAgentBtn = document.getElementById("stopAgentBtn") as HTMLButtonElement;
  const authBootstrapBtn = document.getElementById("authBootstrapBtn") as HTMLButtonElement;
  const pauseBtn = document.getElementById("pauseBtn") as HTMLButtonElement;
  const resumeBtn = document.getElementById("resumeBtn") as HTMLButtonElement;
  const startChoiceBtn = document.getElementById("choiceStartBusinessBtn") as HTMLButtonElement;
  const growChoiceBtn = document.getElementById("choiceGrowBusinessBtn") as HTMLButtonElement;
  const exploreChoiceBtn = document.getElementById("choiceExploreBtn") as HTMLButtonElement;
  const runLeadModeBtn = document.getElementById("runLeadModeBtn") as HTMLButtonElement;
  const sendChatBtn = document.getElementById("sendChatBtn") as HTMLButtonElement;

  killButton.onclick = async () => {
    await fetchJson(`${API_BASE}/kill`, { method: "POST" });
    popupDismissed.clear();
    closeApprovalModal();
    setAgentStatus("Interrupted.", "error");
    chat("agent", "Execution interrupted.", true);
    await refreshQueue();
  };

  saveSettingsBtn.onclick = async () => saveSettings();
  refreshQueueBtn.onclick = async () => refreshQueue();
  registerDeviceBtn.onclick = async () => registerDevice();

  startAgentBtn.onclick = async () => {
    const out = await window.desktopBridge?.startLocalAgent();
    if (out?.message) logLine(out.message);
  };

  stopAgentBtn.onclick = async () => {
    const out = await window.desktopBridge?.stopLocalAgent();
    if (out?.message) logLine(out.message);
  };

  authBootstrapBtn.onclick = async () => bootstrapAuth(false);
  pauseBtn.onclick = async () => pauseOperator();
  resumeBtn.onclick = async () => resumeOperator();

  startChoiceBtn.onclick = async () => createRunFromGoal(goalSeed("start"));
  growChoiceBtn.onclick = async () => createRunFromGoal(goalSeed("grow"));
  exploreChoiceBtn.onclick = async () => createRunFromGoal(goalSeed("explore"));
  runLeadModeBtn.onclick = async () => {
    const leads = await collectLeadModeInput();
    await runLeadMode("Generate personalized outreach for provided leads", leads);
  };

  sendChatBtn.onclick = async () => {
    const text = chatInput.value;
    chatInput.value = "";
    await handleCommand(text);
  };

  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const text = chatInput.value;
    chatInput.value = "";
    void handleCommand(text);
  });

  focusModeToggle.onchange = () => {
    setPresence({ mode: focusModeToggle.checked ? "glow" : "orb" });
    void saveSettings();
  };

  modalApproveBtn.onclick = async () => {
    if (!popupActionId) return;
    await decideAction(popupActionId, "approve");
    popupDismissed.add(popupActionId);
    closeApprovalModal();
    await refreshQueue();
  };

  modalAllowSessionBtn.onclick = async () => {
    if (!popupActionId) return;
    const action = latestQueue.find((item) => item.id === popupActionId);
    const permissions = action?.required_permissions ?? [];
    if (permissions.length > 0) await grantPermissions(permissions, "session");
    await decideAction(popupActionId, "approve");
    popupDismissed.add(popupActionId);
    closeApprovalModal();
    await refreshQueue();
  };

  modalAllowAlwaysBtn.onclick = async () => {
    if (!popupActionId) return;
    const action = latestQueue.find((item) => item.id === popupActionId);
    const permissions = action?.required_permissions ?? [];
    if (permissions.length > 0) await grantPermissions(permissions, "always");
    await decideAction(popupActionId, "approve");
    popupDismissed.add(popupActionId);
    closeApprovalModal();
    await refreshQueue();
  };

  modalRejectBtn.onclick = async () => {
    if (!popupActionId) return;
    await decideAction(popupActionId, "reject");
    popupDismissed.add(popupActionId);
    closeApprovalModal();
    await refreshQueue();
  };

  modalLaterBtn.onclick = () => {
    if (!popupActionId) return;
    popupDismissed.add(popupActionId);
    closeApprovalModal();
    refreshPermissionPopup();
  };
}

function connectLogs(): void {
  const ws = new WebSocket("ws://127.0.0.1:7788/logs/stream");
  ws.onopen = () => {
    logLine("Connected to log stream.");
    setAgentStatus("Live stream connected.", "idle");
  };
  ws.onmessage = (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as { type: string; data: any };
      if (parsed.type === "log") {
        const eventType = String(parsed.data.event_type ?? "");
        logLine(`${parsed.data.level.toUpperCase()} ${eventType}: ${parsed.data.message}`);
        if (eventType === "action_retry_required") setAgentStatus("Needs permission/login.", "permission");
        else if (eventType === "action_running") setAgentStatus("Action running...", "working");
        else if (eventType === "action_success") setAgentStatus("Action completed.", "success");
        else if (eventType === "action_failed") setAgentStatus("Action failed.", "error");
      }
      if (parsed.type === "queue_snapshot") {
        const actions = parsed.data.actions as QueueAction[];
        renderQueue(actions);
        renderRuns(actions);
      }
      if (parsed.type === "cognition_state") {
        applyCognitionState(parsed.data as CognitionSnapshot);
      }
      if (parsed.type === "intent_event") {
        const intent = parsed.data as CognitionIntent;
        appendIntentLine(intent.intent, intent.status);
      }
    } catch {
      // noop
    }
  };
  ws.onclose = () => {
    logLine("Log stream disconnected. Retrying...");
    setAgentStatus("Reconnecting...", "error");
    setTimeout(connectLogs, 2000);
  };
}

async function boot(): Promise<void> {
  bindEvents();
  window.addEventListener("focus", () => {
    void sendInteraction("observation", "window_focus", true);
  });
  window.addEventListener("blur", () => {
    void sendInteraction("observation", "window_blur", false);
  });

  window.desktopBridge?.onProcessLog((msg) => logLine(msg));
  window.desktopBridge?.onPresenceData?.((payload) => {
    if (payload.text && payload.text !== agentStatusLine.textContent) agentStatusLine.textContent = payload.text;
  });

  chat("agent", "I am live. Tell me the outcome you want, and I will adaptively execute.", true);
  setAgentStatus("Ready.", "idle");
  startAutoPairing();

  try {
    await refreshHealth();
    await refreshSettings();
    await refreshQueue();
    await refreshCognitionState();
    if (!authBootstrapDone) {
      authBootstrapDone = true;
      setTimeout(() => {
        void bootstrapAuth(true).catch(() => {
          // noop
        });
      }, 1000);
    }
  } catch (error) {
    logLine(`Initial load failed: ${String(error)}`);
    setAgentStatus("Waiting for local agent...", "error");
  }

  connectLogs();
  setInterval(() => {
    void refreshHealth();
  }, 5000);
  setInterval(() => {
    void refreshCognitionState();
  }, 4200);
}

void boot();

export {};
