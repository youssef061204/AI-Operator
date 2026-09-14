import { OsInputStepSchema, type OsInputStep } from "@operator-assist/shared";
import { slugify } from "./utils.js";

type SessionMode = "generic" | "agency_launch" | "instagram_dm";
type PendingField = "niche" | "location" | "offer" | "instagram_recipient" | "instagram_message";

type AgencyLaunchContext = {
  niche?: string;
  location?: string;
  offer?: string;
  brand_name?: string;
  instagram_recipient?: string;
  instagram_message?: string;
};

type ControlSession = {
  id: string;
  mode: SessionMode;
  pending_field?: PendingField;
  context: AgencyLaunchContext;
  updated_at: string;
  history: string[];
};

type BrainAction = {
  description: string;
  objective: string;
  steps?: OsInputStep[];
};

type BrainDecision =
  | {
      mode: "needs_input";
      question: string;
      session_id: string;
      summary: string;
    }
  | {
      mode: "queued";
      summary: string;
      session_id: string;
      actions: BrainAction[];
      reset_session?: boolean;
    };

type ReasonerPayload = {
  mode?: string;
  summary?: string;
  question?: string;
  actions?: Array<{ description?: string; objective?: string; steps?: unknown[] }>;
  slots?: Partial<AgencyLaunchContext>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function cleanText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function looksLikeDirectCommand(text: string): boolean {
  return /^(open|create|type|press|hit|click|move|scroll|test)\b/i.test(text);
}

function looksLikeAgencyLaunch(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    /\b(ai|automation)\s+agency\b/.test(normalized) ||
    /\b(start|launch|build|create)\b.*\b(agency|business|company)\b/.test(normalized)
  );
}

function parseNicheAndLocation(text: string): { niche?: string; location?: string } {
  const normalized = cleanText(text);
  const match = normalized.match(/for\s+(.+?)\s+in\s+([a-z0-9 .,&-]+)$/i);
  if (match) {
    return {
      niche: cleanText(match[1]),
      location: cleanText(match[2]),
    };
  }
  return {};
}

function buildCreateFolderSteps(folderName: string): OsInputStep[] {
  return [
    { kind: "hotkey", keys: ["ctrl", "esc"] },
    { kind: "delay", ms: 220 },
    { kind: "type", text: "file explorer" },
    { kind: "key", key: "enter" },
    { kind: "delay", ms: 980 },
    { kind: "hotkey", keys: ["ctrl", "shift", "n"] },
    { kind: "delay", ms: 180 },
    { kind: "type", text: folderName },
    { kind: "key", key: "enter" },
  ];
}

function buildOpenChromeUsefulSteps(): OsInputStep[] {
  return [
    { kind: "hotkey", keys: ["ctrl", "esc"] },
    { kind: "delay", ms: 220 },
    { kind: "type", text: "chrome" },
    { kind: "key", key: "enter" },
    { kind: "delay", ms: 1200 },
    { kind: "hotkey", keys: ["ctrl", "l"] },
    { kind: "delay", ms: 120 },
    { kind: "type", text: "https://mail.google.com" },
    { kind: "key", key: "enter" },
  ];
}

function looksLikeInstagramDmTask(text: string): boolean {
  const normalized = text.toLowerCase();
  return /instagram/.test(normalized) && /(dm|direct message|message|inbox)/.test(normalized);
}

function parseInstagramDm(text: string): { recipient?: string; message?: string } {
  const normalized = cleanText(text);
  const messageQuoted = normalized.match(/["']([^"']+)["']/)?.[1]?.trim();
  const recipientMatch = normalized.match(/(?:dm|message|direct message)\s+(?:to\s+)?([a-z0-9._\-\s]{2,48}?)(?:\s+(?:saying|that says|with message)\s+|$)/i);
  const recipient = recipientMatch?.[1]?.trim().replace(/\s{2,}/g, " ");
  const messageMatch = normalized.match(/(?:saying|that says|with message)\s+(.+)$/i)?.[1]?.trim();
  const message = messageQuoted || messageMatch;
  return {
    recipient: recipient ? cleanText(recipient) : undefined,
    message: message ? cleanText(message) : undefined,
  };
}

export class ControlBrain {
  private readonly sessions = new Map<string, ControlSession>();
  private readonly reasonerProvider = cleanText(process.env.OPERATOR_BRAIN_PROVIDER || "auto").toLowerCase();
  private readonly remoteReasonerKey = process.env.OPERATOR_BRAIN_OPENAI_KEY || process.env.OPENAI_API_KEY || "";
  private readonly remoteReasonerModel = process.env.OPERATOR_BRAIN_OPENAI_MODEL || process.env.OPERATOR_BRAIN_MODEL || "gpt-4.1-mini";
  private readonly ollamaBase = String(process.env.OPERATOR_BRAIN_OLLAMA_BASE || "http://127.0.0.1:11434").trim().replace(/\/+$/, "");
  private readonly ollamaModel = String(process.env.OPERATOR_BRAIN_OLLAMA_MODEL || "qwen2.5:7b-instruct").trim() || "qwen2.5:7b-instruct";
  private readonly allowPointerSteps = true;
  private readonly reasonerTimeoutMs = (() => {
    const raw = Number(process.env.OPERATOR_BRAIN_TIMEOUT_MS || "120000");
    if (!Number.isFinite(raw) || raw <= 0) return 120000;
    return Math.max(2000, Math.min(120000, Math.floor(raw)));
  })();
  private readonly ollamaModelCacheMs = 30000;
  private cachedResolvedOllamaModel: string | null = null;
  private cachedResolvedOllamaAt = 0;

  resetSession(sessionId: string): void {
    const id = cleanText(sessionId) || "default";
    this.sessions.delete(id);
  }

  private getSession(sessionId: string): ControlSession {
    const id = cleanText(sessionId) || "default";
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const created: ControlSession = {
      id,
      mode: "generic",
      context: {},
      updated_at: nowIso(),
      history: [],
    };
    this.sessions.set(id, created);
    return created;
  }

  private updateSession(session: ControlSession, userMessage: string): void {
    session.history = [...session.history.slice(-10), cleanText(userMessage)];
    session.updated_at = nowIso();
  }

  private ask(session: ControlSession, field: PendingField, question: string, summary: string): BrainDecision {
    session.pending_field = field;
    return {
      mode: "needs_input",
      question,
      summary,
      session_id: session.id,
    };
  }

  private buildAgencyLaunchPlan(session: ControlSession): BrainDecision {
    const niche = cleanText(session.context.niche || "local businesses");
    const location = cleanText(session.context.location || "your target city");
    const offer = cleanText(session.context.offer || "AI automation setup");
    const folderName = `AI Agency - ${slugify(`${niche}-${location}`)}`.slice(0, 64) || "AI-Agency-Launch";

    session.pending_field = undefined;
    session.mode = "generic";
    session.context = {};

    return {
      mode: "queued",
      session_id: session.id,
      summary: `Collected your agency inputs. Executing launch setup for ${niche} in ${location} with offer "${offer}".`,
      reset_session: true,
      actions: [
        {
          description: "Create agency workspace folder",
          objective: `Create new folder named ${folderName}`,
          steps: buildCreateFolderSteps(folderName),
        },
        {
          description: "Open Gmail in Chrome for outreach setup",
          objective: "Open chrome and go to gmail",
          steps: buildOpenChromeUsefulSteps(),
        },
      ],
    };
  }

  private absorbPendingAnswer(session: ControlSession, message: string): void {
    const value = cleanText(message);
    const parsed = parseNicheAndLocation(value);

    if (session.pending_field === "niche") {
      session.context.niche = parsed.niche || value;
      if (parsed.location && !session.context.location) session.context.location = parsed.location;
      session.pending_field = undefined;
      return;
    }
    if (session.pending_field === "location") {
      session.context.location = value;
      session.pending_field = undefined;
      return;
    }
    if (session.pending_field === "offer") {
      session.context.offer = value;
      session.pending_field = undefined;
      return;
    }
  }

  private continueAgencyConversation(session: ControlSession, message: string): BrainDecision {
    if (session.pending_field) {
      this.absorbPendingAnswer(session, message);
    } else {
      const parsed = parseNicheAndLocation(message);
      if (parsed.niche && !session.context.niche) session.context.niche = parsed.niche;
      if (parsed.location && !session.context.location) session.context.location = parsed.location;
    }

    if (!session.context.niche) {
      return this.ask(
        session,
        "niche",
        "Who should this AI agency serve first? Example: dentists in Austin.",
        "I need your target niche before building the launch plan.",
      );
    }
    if (!session.context.location) {
      return this.ask(
        session,
        "location",
        "What city or market should we launch in first?",
        "Got the niche. I need the initial market location.",
      );
    }
    if (!session.context.offer) {
      return this.ask(
        session,
        "offer",
        "What is the first paid offer we should sell?",
        "I need your core offer so I can generate the launch execution.",
      );
    }
    return this.buildAgencyLaunchPlan(session);
  }

  private buildInstagramDmPlan(session: ControlSession): BrainDecision {
    const recipient = cleanText(session.context.instagram_recipient || "");
    const dmText = cleanText(session.context.instagram_message || "");

    session.pending_field = undefined;
    session.mode = "generic";
    session.context = {};

    return {
      mode: "queued",
      session_id: session.id,
      summary: `Opening Instagram DM and sending your message to ${recipient}.`,
      reset_session: true,
      actions: [
        {
          description: "Open Instagram DMs in Chrome",
          objective: "Open chrome and load instagram new message composer",
          steps: [
            { kind: "hotkey", keys: ["ctrl", "esc"] },
            { kind: "delay", ms: 220 },
            { kind: "type", text: "chrome" },
            { kind: "key", key: "enter" },
            { kind: "delay", ms: 1300 },
            { kind: "hotkey", keys: ["ctrl", "l"] },
            { kind: "delay", ms: 120 },
            { kind: "type", text: "https://www.instagram.com/direct/new/" },
            { kind: "key", key: "enter" },
            { kind: "delay", ms: 2600 },
          ],
        },
        {
          description: `Find recipient "${recipient}" in DMs`,
          objective: "Focus recipient input and open target conversation",
          steps: [
            { kind: "vision_click_text", text: "To", alternatives: ["To:", "Search...", "Search", "Recipient"], button: "left", retries: 5 },
            { kind: "delay", ms: 180 },
            { kind: "type", text: recipient },
            { kind: "delay", ms: 900 },
            { kind: "key", key: "enter" },
            { kind: "delay", ms: 800 },
            { kind: "vision_click_text", text: "Chat", alternatives: ["Next", "Done", "Continue"], button: "left", retries: 4 },
            { kind: "delay", ms: 1200 },
          ],
        },
        {
          description: "Type and send DM",
          objective: "Focus message input and send text",
          steps: [
            { kind: "vision_click_text", text: "Message", alternatives: ["Write a message", "Write a message...", "Aa", "Send message"], button: "left", retries: 5 },
            { kind: "delay", ms: 120 },
            { kind: "type", text: dmText },
            { kind: "key", key: "enter" },
          ],
        },
      ],
    };
  }

  private continueInstagramConversation(session: ControlSession, message: string): BrainDecision {
    if (session.pending_field === "instagram_recipient") {
      session.context.instagram_recipient = cleanText(message);
      session.pending_field = undefined;
    } else if (session.pending_field === "instagram_message") {
      session.context.instagram_message = cleanText(message);
      session.pending_field = undefined;
    } else {
      const parsed = parseInstagramDm(message);
      if (parsed.recipient && !session.context.instagram_recipient) session.context.instagram_recipient = parsed.recipient;
      if (parsed.message && !session.context.instagram_message) session.context.instagram_message = parsed.message;
    }

    if (!session.context.instagram_recipient) {
      return this.ask(
        session,
        "instagram_recipient",
        "Who should I message on Instagram?",
        "I need the recipient username or display name first.",
      );
    }

    if (!session.context.instagram_message) {
      return this.ask(
        session,
        "instagram_message",
        `What exact message should I send to ${session.context.instagram_recipient}?`,
        "I need the exact DM text before executing.",
      );
    }

    return this.buildInstagramDmPlan(session);
  }

  private buildSystemPrompt(): string {
    return [
      "You are the hidden reasoning brain for a desktop control agent.",
      "Your job: transform user goal text into either:",
      "1) ask: one concise clarifying question when essential info is missing",
      "2) execute: immediate concrete next action with explicit OS input steps",
      "Rules:",
      "- No generic web search objectives.",
      "- Prefer concrete operations (open app, navigate, type, click, submit).",
      "- Ask follow-up questions until you have enough detail for full execution.",
      "- In execute mode, output only the immediate next micro-plan (not full workflow).",
      "- Assume the machine starts at desktop state; include opening apps/windows as needed.",
      "- Make each action independently executable and observable.",
      "- Return exactly 1 action with 1-6 steps.",
      "- Keep output JSON only.",
      "- Allowed step kinds: move, drag, click, scroll, vision_click_text, type, key, hotkey, delay.",
      "- Use hotkey+type+key flows for reliability (example: ctrl+esc -> type app -> enter).",
      "- Do not use win/meta/windows hotkeys. Use ctrl+esc based flows instead.",
      "- Do not use ctrl+f for site interactions. Use tab/click targeting of real input fields.",
      "- Prefer vision_click_text for web UIs when fields/buttons must be targeted.",
      "- Once browser page is open, navigate by visible controls (vision_click_text + type), not generic search engines.",
      "JSON schema:",
      "{\"mode\":\"ask|execute\",\"summary\":\"...\",\"question\":\"...\",\"actions\":[{\"description\":\"...\",\"objective\":\"...\",\"steps\":[{\"kind\":\"hotkey\",\"keys\":[\"ctrl\",\"esc\"]},{\"kind\":\"type\",\"text\":\"chrome\"},{\"kind\":\"key\",\"key\":\"enter\"}]}],\"slots\":{\"niche\":\"...\",\"location\":\"...\",\"offer\":\"...\"}}",
    ].join("\n");
  }

  private buildUserPrompt(session: ControlSession, message: string): string {
    const historyText = session.history.slice(-6).join("\n");
    return [
      `Session mode: ${session.mode}`,
      `Known context: ${JSON.stringify(session.context)}`,
      `Recent messages:\n${historyText}`,
      `Current message: ${message}`,
    ].join("\n\n");
  }

  private async fetchOllamaModelNames(): Promise<string[]> {
    if (!this.ollamaBase) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.reasonerTimeoutMs);
    try {
      const response = await fetch(`${this.ollamaBase}/api/tags`, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) return [];
      const payload = await response.json() as Record<string, unknown>;
      const models = Array.isArray(payload.models) ? payload.models as Array<Record<string, unknown>> : [];
      const names = models
        .map((item) => String(item.name ?? "").trim())
        .filter(Boolean);
      return Array.from(new Set(names));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveOllamaModel(): Promise<string | null> {
    const now = Date.now();
    if ((now - this.cachedResolvedOllamaAt) < this.ollamaModelCacheMs) {
      return this.cachedResolvedOllamaModel;
    }

    const names = await this.fetchOllamaModelNames();
    const resolved = names.includes(this.ollamaModel) ? this.ollamaModel : (names[0] ?? null);
    this.cachedResolvedOllamaModel = resolved;
    this.cachedResolvedOllamaAt = now;
    return resolved;
  }

  async getReasonerStatus(): Promise<Record<string, unknown>> {
    const names = await this.fetchOllamaModelNames();
    const resolved = names.includes(this.ollamaModel) ? this.ollamaModel : (names[0] ?? null);
    return {
      provider: this.reasonerProvider,
      openai_configured: Boolean(this.remoteReasonerKey),
      openai_model: this.remoteReasonerModel,
      ollama_base: this.ollamaBase,
      ollama_configured_model: this.ollamaModel,
      ollama_available_models: names,
      ollama_resolved_model: resolved,
      ollama_ready: Boolean(resolved),
    };
  }

  private parseReasonerPayload(rawContent: string): ReasonerPayload | null {
    const trimmed = String(rawContent || "").trim();
    if (!trimmed) return null;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] ?? trimmed;
    const candidates = [fenced];
    const firstBrace = fenced.indexOf("{");
    const lastBrace = fenced.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(fenced.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as ReasonerPayload;
      } catch {
        // try next candidate
      }
    }

    return null;
  }

  private decisionFromReasonerPayload(session: ControlSession, parsed: ReasonerPayload): BrainDecision | null {
    if (parsed.slots && typeof parsed.slots === "object") {
      if (parsed.slots.niche) session.context.niche = cleanText(String(parsed.slots.niche));
      if (parsed.slots.location) session.context.location = cleanText(String(parsed.slots.location));
      if (parsed.slots.offer) session.context.offer = cleanText(String(parsed.slots.offer));
    }

    if (parsed.mode === "ask" && parsed.question) {
      return {
        mode: "needs_input",
        session_id: session.id,
        summary: cleanText(parsed.summary || "I need one detail before executing."),
        question: cleanText(parsed.question),
      };
    }

    if (parsed.mode === "execute") {
      const actions = (Array.isArray(parsed.actions) ? parsed.actions : [])
        .map((item) => {
          const description = cleanText(String(item.description || ""));
          const objectiveBase = cleanText(String(item.objective || ""));
          const objective = cleanText(
            objectiveBase && description && !objectiveBase.toLowerCase().includes(description.toLowerCase())
              ? `${objectiveBase}. ${description}`
              : (objectiveBase || description),
          );
          const steps = Array.isArray(item.steps)
            ? item.steps
                .map((step) => {
                  try {
                    return OsInputStepSchema.parse(step);
                  } catch {
                    return null;
                  }
                })
                .filter((step): step is OsInputStep => Boolean(step))
            : [];
          const normalizedSteps = this.normalizeGeneratedSteps(objective, steps);
          const safeSteps = (normalizedSteps.length >= 3 && this.isLikelyExecutablePlan(objective, normalizedSteps))
            ? normalizedSteps
            : [];
          return { description, objective, steps: safeSteps.slice(0, 6) };
        })
        .filter((item) => item.objective.length > 0)
        .slice(0, 1);
      if (actions.length > 0) {
        return {
          mode: "queued",
          session_id: session.id,
          summary: cleanText(parsed.summary || "Executing generated action plan."),
          actions,
        };
      }
    }

    return null;
  }

  private normalizeGeneratedSteps(objective: string, steps: OsInputStep[]): OsInputStep[] {
    const normalized: OsInputStep[] = [];
    const objectiveText = String(objective || "").toLowerCase();
    const findIntent = /\b(find|locate|search text|find on page)\b/.test(objectiveText);
    let seenMove = false;
    for (const step of steps) {
      if (step.kind === "drag") {
        normalized.push(step);
        seenMove = false;
        continue;
      }
      if (!this.allowPointerSteps && (step.kind === "move" || step.kind === "click")) {
        continue;
      }
      if (step.kind === "move") {
        normalized.push(step);
        seenMove = true;
        continue;
      }
      if (step.kind === "click") {
        normalized.push(step);
        continue;
      }

      if (step.kind !== "hotkey") {
        normalized.push(step);
        seenMove = false;
        continue;
      }

      const keys = step.keys.map((key) => String(key || "").trim().toLowerCase()).filter(Boolean);
      const hasWin = keys.some((key) => key === "win" || key === "meta" || key === "windows");
      const ctrlF = (keys.includes("ctrl") || keys.includes("control")) && keys.includes("f");
      if (ctrlF && !findIntent) {
        normalized.push({ kind: "key", key: "tab" });
        seenMove = false;
        continue;
      }
      if (!hasWin) {
        normalized.push(step);
        seenMove = false;
        continue;
      }

      const others = keys.filter((key) => key !== "win" && key !== "meta" && key !== "windows");
      if (others.length === 1 && others[0] === "e") {
        normalized.push(
          { kind: "hotkey", keys: ["ctrl", "esc"] },
          { kind: "delay", ms: 220 },
          { kind: "type", text: "file explorer" },
          { kind: "key", key: "enter" },
          { kind: "delay", ms: 900 },
        );
        seenMove = false;
        continue;
      }

      if (others.length === 1 && others[0] === "d") {
        continue;
      }

      normalized.push({ kind: "hotkey", keys: ["ctrl", "esc"] });
      seenMove = false;
    }
    return normalized.slice(0, 120);
  }

  private isLikelyExecutablePlan(objective: string, steps: OsInputStep[]): boolean {
    if (steps.length < 3) return false;
    const text = objective.toLowerCase();

    const hotkeys = steps
      .filter((step): step is Extract<OsInputStep, { kind: "hotkey" }> => step.kind === "hotkey")
      .map((step) => step.keys.map((key) => String(key || "").trim().toLowerCase()));
    const typedText = steps
      .filter((step): step is Extract<OsInputStep, { kind: "type" }> => step.kind === "type")
      .map((step) => step.text.toLowerCase());

    const hasHotkey = (needles: string[]): boolean =>
      hotkeys.some((keys) => needles.every((needle) => keys.includes(needle)));
    const hasDrag = steps.some((step) => step.kind === "drag");

    if (/(create|new).*(folder)|folder.*(create|new)/.test(text)) {
      const hasCreateSignal = hasHotkey(["ctrl", "shift", "n"]) || typedText.some((value) => value.includes("new folder"));
      if (!hasCreateSignal) return false;
    }

    if (/move.*(file|pdf|folder)|organize.*(file|pdf|folder)/.test(text)) {
      const hasMoveSignal = hasDrag || hasHotkey(["ctrl", "x"]) || (hasHotkey(["ctrl", "c"]) && hasHotkey(["ctrl", "v"]));
      if (!hasMoveSignal) return false;
    }

    return true;
  }

  private async tryOpenAiReasoner(session: ControlSession, message: string): Promise<BrainDecision | null> {
    if (!this.remoteReasonerKey) return null;
    if (!message) return null;

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(session, message);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.reasonerTimeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.remoteReasonerKey}`,
        },
        body: JSON.stringify({
          model: this.remoteReasonerModel,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json() as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices as Array<Record<string, unknown>> : [];
      const first = choices[0];
      const messageObj = first?.message as Record<string, unknown> | undefined;
      const content = typeof messageObj?.content === "string" ? messageObj.content : "";
      if (!content) return null;

      const parsed = this.parseReasonerPayload(content);
      if (!parsed) return null;
      return this.decisionFromReasonerPayload(session, parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tryOllamaReasoner(session: ControlSession, message: string): Promise<BrainDecision | null> {
    if (!message) return null;
    if (!this.ollamaBase || !this.ollamaModel) return null;
    const model = await this.resolveOllamaModel();
    if (!model) return null;

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(session, message);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.reasonerTimeoutMs);
    try {
      const response = await fetch(`${this.ollamaBase}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          options: { temperature: 0.2, num_predict: 700 },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload = await response.json() as Record<string, unknown>;
      const messageObj = payload.message as Record<string, unknown> | undefined;
      const content = typeof messageObj?.content === "string"
        ? messageObj.content
        : typeof payload.response === "string"
          ? payload.response
          : "";
      if (!content) return null;

      const parsed = this.parseReasonerPayload(content);
      if (!parsed) return null;
      return this.decisionFromReasonerPayload(session, parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tryConfiguredReasoner(session: ControlSession, message: string): Promise<BrainDecision | null> {
    const provider = this.reasonerProvider;
    if (!message || provider === "none" || provider === "off" || provider === "heuristic") return null;

    if (provider === "ollama") {
      return await this.tryOllamaReasoner(session, message);
    }
    if (provider === "openai") {
      return await this.tryOpenAiReasoner(session, message);
    }

    const ollamaDecision = await this.tryOllamaReasoner(session, message);
    if (ollamaDecision) return ollamaDecision;
    return await this.tryOpenAiReasoner(session, message);
  }

  async reason(sessionId: string, userMessage: string): Promise<BrainDecision> {
    const message = cleanText(userMessage);
    const session = this.getSession(sessionId);
    this.updateSession(session, message);

    if (!message) {
      return {
        mode: "needs_input",
        session_id: session.id,
        question: "What should I do on your laptop right now?",
        summary: "Awaiting a task.",
      };
    }

    if (/^(reset|start over|new task|clear)$/i.test(message)) {
      this.resetSession(session.id);
      return {
        mode: "needs_input",
        session_id: session.id,
        question: "Session reset. What do you want me to do now?",
        summary: "Conversation memory cleared.",
      };
    }

    if (session.mode === "instagram_dm") {
      return this.continueInstagramConversation(session, message);
    }
    if (looksLikeInstagramDmTask(message)) {
      session.mode = "instagram_dm";
      return this.continueInstagramConversation(session, message);
    }

    if (session.mode === "agency_launch" || looksLikeAgencyLaunch(message)) {
      session.mode = "agency_launch";
      return this.continueAgencyConversation(session, message);
    }

    const lower = message.toLowerCase();
    if (/(site|website|web page|webpage|chrome)/.test(lower) && /(type|enter|fill|submit)/.test(lower) && !/(https?:\/\/|www\.)/.test(lower)) {
      return {
        mode: "needs_input",
        session_id: session.id,
        summary: "I can execute this, but I need the target URL first.",
        question: "Which exact URL should I open, and what field should I type into there?",
      };
    }

    const remoteDecision = await this.tryConfiguredReasoner(session, message);
    if (remoteDecision) {
      return remoteDecision;
    }

    if (looksLikeDirectCommand(message)) {
      return {
        mode: "queued",
        session_id: session.id,
        summary: "Executing your direct command.",
        actions: [
          {
            description: `Execute command: ${message.slice(0, 80)}`,
            objective: message,
          },
        ],
      };
    }

    return {
      mode: "needs_input",
      session_id: session.id,
      question: "I can execute this, but I need a concrete first action. What should I do first on-screen?",
      summary: "Converted broad intent into collaborative execution mode.",
    };
  }
}

export type { BrainDecision, BrainAction };
