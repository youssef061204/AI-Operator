import { randomUUID } from "node:crypto";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

export function slugify(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || `project-${newId().slice(0, 8)}`;
}

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function redactSecrets(text: string): string {
  if (!text) return "";
  let out = text;
  const patterns = [
    /(gh[pousr]_[A-Za-z0-9_]{20,})/g,
    /(sk-[A-Za-z0-9]{20,})/g,
    /(xox[baprs]-[A-Za-z0-9-]{10,})/g,
    /(Bearer\s+[A-Za-z0-9._-]{12,})/gi,
    /(password\s*[=:]\s*[^\s"']+)/gi,
    /(token\s*[=:]\s*[^\s"']+)/gi,
  ];

  for (const pattern of patterns) {
    out = out.replace(pattern, "[REDACTED]");
  }

  for (const [key, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 10) continue;
    if (/token|secret|key|password/i.test(key)) {
      out = out.split(envValue).join("[REDACTED_ENV]");
    }
  }

  return out;
}

export function extractNicheCity(goal: string): { niche: string; city: string } {
  const trimmed = goal.trim();
  let city = "Austin, Texas";
  const cityMatch = trimmed.match(/\bin\s+([A-Za-z][A-Za-z\s]+(?:,\s*[A-Za-z]{2})?)/i);
  if (cityMatch?.[1]) city = cityMatch[1].trim().replace(/[.?,]+$/, "");

  let niche = "local service businesses";
  const nichePatterns = [/for\s+([A-Za-z0-9\s\-&]+)/i, /help\s+([A-Za-z0-9\s\-&]+)/i, /target(?:ing)?\s+([A-Za-z0-9\s\-&]+)/i];
  for (const pattern of nichePatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      niche = match[1].trim().replace(/[.?,]+$/, "");
      break;
    }
  }

  niche = niche.replace(/\bin\s+[A-Za-z][A-Za-z\s]+$/i, "").trim();
  return { niche: niche || "local service businesses", city };
}
