import path from "node:path";

import type { ActionEnvelope, PipelineRequest } from "@operator-assist/shared";

import { extractNicheCity, nowIso, slugify, newId } from "./utils.js";

export type PlannedLead = {
  company_name: string;
  email: string;
  url: string;
  score: number;
};

export type PlanResult = {
  goal: string;
  offer: {
    niche: string;
    city: string;
    offer_name: string;
    offer_value: string;
    offer_bullets: string[];
  };
  landing_copy: string;
  leads: PlannedLead[];
  outreach_drafts: string[];
};

export type LeadSeed = {
  company_name?: string;
  email?: string;
  url?: string;
};

export function buildPlan(goal: string): PlanResult {
  const { niche, city } = extractNicheCity(goal);
  const offer_name = `AI Operator System for ${niche.replace(/\b\w/g, (x) => x.toUpperCase())}`;
  const offer_value = `Generate and convert more inbound demand for ${niche} in ${city} using an approval-gated AI operator.`;
  const offer_bullets = [
    "Missed-call and lead-response automation",
    "High-intent lead qualification routing",
    "Human-approved outreach and follow-ups",
  ];

  const base = slugify(`${niche}-${city}`);
  const leads: PlannedLead[] = Array.from({ length: 8 }).map((_, idx) => {
    const n = idx + 1;
    const company_name = `${city} ${niche.replace(/\b\w/g, (x) => x.toUpperCase())} ${n}`;
    const domain = `${base}-${n}.com`;
    return {
      company_name,
      email: `hello@${domain}`,
      url: `https://www.${domain}`,
      score: Math.max(6.5, 9.8 - idx * 0.4),
    };
  });

  const outreach_drafts = leads.slice(0, 5).map((lead, idx) => {
    return [
      `Draft ${idx + 1}`,
      `To: ${lead.email}`,
      `Subject: Quick idea to increase bookings at ${lead.company_name}`,
      "",
      `Hi ${lead.company_name} team,`,
      "",
      `I run an AI operator studio helping ${niche} in ${city} convert more inbound leads with faster follow-up and better qualification.`,
      "",
      "If useful, I can share a short teardown and 14-day rollout plan.",
      "",
      "Best,",
      "Operator Assist",
    ].join("\n");
  });

  const landing_copy = [
    `HERO: ${offer_name}`,
    `SUBHEAD: ${offer_value}`,
    `NICHE: ${niche}`,
    `CITY: ${city}`,
    "BULLETS:",
    ...offer_bullets.map((x) => `- ${x}`),
    "CTA: Book 20-minute Operator Audit",
  ].join("\n");

  return {
    goal,
    offer: { niche, city, offer_name, offer_value, offer_bullets },
    landing_copy,
    leads,
    outreach_drafts,
  };
}

function buildComposeUrl(email: string, subject: string, body: string): string {
  const q = new URLSearchParams({ view: "cm", fs: "1", to: email, su: subject, body });
  return `https://mail.google.com/mail/?${q.toString()}`;
}

function titleCaseWords(value: string): string {
  return value
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function inferDomain(seed: LeadSeed): string | null {
  const rawUrl = String(seed.url ?? "").trim();
  if (rawUrl) {
    const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    try {
      const host = new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
      if (host) return host;
    } catch {
      // noop
    }
  }

  const email = String(seed.email ?? "").trim().toLowerCase();
  if (email.includes("@")) {
    const host = email.split("@")[1]?.trim();
    if (host) return host.replace(/^www\./, "");
  }

  return null;
}

function normalizeLead(seed: LeadSeed, idx: number): PlannedLead {
  const domain = inferDomain(seed);
  const cleanCompany = String(seed.company_name ?? "").trim();
  const company_name = cleanCompany
    || (domain ? titleCaseWords(domain.replace(/\.[a-z0-9-]+$/i, "").replace(/[^a-z0-9]+/gi, " ")) : `Lead ${idx + 1}`);
  const email = String(seed.email ?? "").trim() || (domain ? `hello@${domain}` : `hello+lead${idx + 1}@example.com`);
  const url = String(seed.url ?? "").trim() || (domain ? `https://www.${domain}` : "https://example.com");
  const score = Math.max(6.2, 9.7 - idx * 0.25);
  return { company_name, email, url, score };
}

function makeAction(params: {
  runId: string;
  projectId: string;
  type: ActionEnvelope["type"];
  description: string;
  riskLevel: ActionEnvelope["risk_level"];
  requiredPermissions: string[];
  inputs: Record<string, unknown>;
}): ActionEnvelope {
  const now = nowIso();
  return {
    id: newId(),
    run_id: params.runId,
    project_id: params.projectId,
    type: params.type,
    description: params.description,
    risk_level: params.riskLevel,
    required_permissions: params.requiredPermissions,
    inputs: params.inputs,
    state: "QUEUED",
    created_at: now,
    updated_at: now,
  };
}

export function buildDemoPipeline(input: PipelineRequest): {
  run_id: string;
  project_slug: string;
  project_dir: string;
  plan: PlanResult;
  actions: ActionEnvelope[];
} {
  const runId = newId();
  const plan = buildPlan(input.goal);
  const projectSlug = `${slugify(plan.offer.offer_name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const workspaceRoot = path.resolve(input.workspace_root);
  const projectDir = path.join(workspaceRoot, projectSlug);

  const actions: ActionEnvelope[] = [
    makeAction({
      runId,
      projectId: projectSlug,
      type: "PLAN_GOAL",
      description: "Generate niche, offer, leads, and outreach drafts",
      riskLevel: "LOW",
      requiredPermissions: ["planning"],
      inputs: { goal: input.goal },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "CREATE_BUSINESS_FOLDER",
      description: "Create timestamped business workspace folder",
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.write"],
      inputs: { workspace_root: workspaceRoot, project_slug: projectSlug, project_dir: projectDir },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "SCAFFOLD_NEXTJS_SITE",
      description: "Scaffold styled Next.js site",
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.write"],
      inputs: {
        project_dir: projectDir,
        offer_name: plan.offer.offer_name,
        offer_value: plan.offer.offer_value,
        niche: plan.offer.niche,
        city: plan.offer.city,
        bullets: plan.offer.offer_bullets,
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "INSTALL_DEPENDENCIES",
      description: "Install site dependencies",
      riskLevel: "MEDIUM",
      requiredPermissions: ["cli.package_manager"],
      inputs: { project_dir: projectDir, package_manager: "npm" },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "GIT_INIT",
      description: "Initialize git repository",
      riskLevel: "MEDIUM",
      requiredPermissions: ["cli.git"],
      inputs: { project_dir: projectDir },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "START_LOCAL_PREVIEW",
      description: "Start local website preview server",
      riskLevel: "LOW",
      requiredPermissions: ["cli.process"],
      inputs: {
        project_dir: projectDir,
        command: "npm run dev -- --port 3000",
        port: 3000,
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "CHECK_SERVER_HEALTH",
      description: "Verify local preview is reachable",
      riskLevel: "LOW",
      requiredPermissions: ["network.local"],
      inputs: {
        url: "http://127.0.0.1:3000",
        expected_status: 200,
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "GMAIL_DRAFTS",
      description: "Create outreach draft bundle",
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.write"],
      inputs: {
        project_dir: projectDir,
        drafts: plan.outreach_drafts,
        compose_urls: [],
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "SYNTHESIZE_TOOL",
      description: "Synthesize reusable deployment optimization tool",
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.write", "cli.node"],
      inputs: {
        capability: "deploy.optimizer",
        purpose: "Prepare reusable deployment and launch validator",
        project_id: projectSlug,
        sample_input: {
          project_dir: projectDir,
          provider: input.provider,
        },
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "LOCAL_RESEARCH",
      description: "Research market and launch positioning signals",
      riskLevel: "LOW",
      requiredPermissions: ["network.request"],
      inputs: {
        query: `${plan.offer.niche} ${plan.offer.city} pricing and conversion benchmarks`,
        max_results: 6,
        sources: [],
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "PUBLISH_GITHUB",
      description: "Attempt GitHub publish via gh CLI",
      riskLevel: "HIGH",
      requiredPermissions: ["cli.git", "network.github"],
      inputs: {
        project_dir: projectDir,
        repo_name: projectSlug,
        private: true,
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "DEPLOY_SITE",
      description: `Deploy site using ${input.provider}`,
      riskLevel: "HIGH",
      requiredPermissions: ["network.deploy"],
      inputs: {
        project_dir: projectDir,
        provider: input.provider,
        prod: false,
      },
    }),
  ];

  return { run_id: runId, project_slug: projectSlug, project_dir: projectDir, plan, actions };
}

export function buildLeadModePipeline(input: {
  goal: string;
  workspace_root: string;
  provider: PipelineRequest["provider"];
  leads: LeadSeed[];
}): {
  run_id: string;
  project_slug: string;
  project_dir: string;
  plan: PlanResult;
  actions: ActionEnvelope[];
} {
  const runId = newId();
  const workspaceRoot = path.resolve(input.workspace_root);
  const plan = buildPlan(input.goal);
  const normalizedLeads = input.leads.slice(0, 30).map((seed, idx) => normalizeLead(seed, idx));
  const outreachDrafts = normalizedLeads.slice(0, 20).map((lead, idx) => {
    return [
      `Draft ${idx + 1}`,
      `To: ${lead.email}`,
      `Subject: Quick idea for ${lead.company_name}`,
      "",
      `Hi ${lead.company_name} team,`,
      "",
      `I looked at ${lead.url} and saw an opportunity to help ${plan.offer.niche} in ${plan.offer.city} convert more inbound demand with approval-gated AI operator workflows.`,
      "",
      "If useful, I can send a short teardown and outreach sequence tailored to your funnel this week.",
      "",
      "Best,",
      "Operator Assist",
    ].join("\n");
  });

  const composeUrls = normalizedLeads.slice(0, 10).map((lead) =>
    buildComposeUrl(
      lead.email,
      `Quick idea for ${lead.company_name}`,
      `Hi ${lead.company_name} team,\n\nI reviewed ${lead.url} and have a few ideas to improve conversion with an approval-gated AI operator flow.\n\nIf useful, I can share a short teardown this week.`,
    ),
  );

  const projectSlug = `lead-mode-${slugify(plan.offer.offer_name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const projectDir = path.join(workspaceRoot, projectSlug);
  const enrichedPlan: PlanResult = {
    ...plan,
    leads: normalizedLeads,
    outreach_drafts: outreachDrafts,
  };

  const actions: ActionEnvelope[] = [
    makeAction({
      runId,
      projectId: projectSlug,
      type: "PLAN_GOAL",
      description: "Analyze provided leads and generate personalized outreach plan",
      riskLevel: "LOW",
      requiredPermissions: ["planning"],
      inputs: { goal: input.goal },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "CREATE_BUSINESS_FOLDER",
      description: "Create lead-mode workspace folder",
      riskLevel: "MEDIUM",
      requiredPermissions: ["filesystem.write"],
      inputs: { workspace_root: workspaceRoot, project_slug: projectSlug, project_dir: projectDir },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "OPEN_TABS",
      description: "Open lead-mode tabs (runs page + connect page + gmail)",
      riskLevel: "LOW",
      requiredPermissions: ["browser.open_tab"],
      inputs: {
        urls: [
          `http://localhost:3000/runs?run_id=${encodeURIComponent(runId)}`,
          "http://localhost:3000/connect-device",
          "https://mail.google.com",
        ],
      },
    }),
    makeAction({
      runId,
      projectId: projectSlug,
      type: "GMAIL_DRAFTS",
      description: "Generate personalized outreach drafts and open compose tabs",
      riskLevel: "HIGH",
      requiredPermissions: ["filesystem.write", "browser.open_tab"],
      inputs: {
        project_dir: projectDir,
        drafts: outreachDrafts,
        compose_urls: composeUrls,
      },
    }),
  ];

  return {
    run_id: runId,
    project_slug: projectSlug,
    project_dir: projectDir,
    plan: enrichedPlan,
    actions,
  };
}
