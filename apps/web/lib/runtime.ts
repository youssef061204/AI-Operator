export const RUNTIME_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:7788";
export type Task = {
  id: string;
  objective: string;
  status: string;
  plan: string[];
  summary?: string;
  error?: string;
  approval?: {
    id: string;
    digest: string;
    call: object;
    reason: string;
    risk: string;
    resources: string[];
    expiresAt: number;
  };
  observations: Array<{
    step: number;
    call: unknown;
    result?: unknown;
    error?: unknown;
  }>;
  metrics: object;
  verification: object[];
  checkpoints: string[];
};
export type RuntimeEvent = {
  seq: number;
  type: string;
  at: number;
  data: unknown;
};
export async function runtime<T>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${RUNTIME_BASE}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (!response.ok)
    throw new Error(
      `${response.status}: ${(await response.text()).slice(0, 2000)}`,
    );
  return response.json() as Promise<T>;
}
