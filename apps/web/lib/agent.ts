export const AGENT_BASE = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://127.0.0.1:7788";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }

  return (await res.json()) as T;
}

export function createLogWs(): WebSocket {
  const base = AGENT_BASE.replace("http://", "ws://").replace("https://", "wss://");
  return new WebSocket(`${base}/logs/stream`);
}
