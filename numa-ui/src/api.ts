import type { Execution, Tool } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `gateway returned HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const fetchTools = () => request<Tool[]>("/v1/tools");
export const fetchExecutions = () => request<Execution[]>("/v1/executions?limit=40");

export const runCommand = (text: string) =>
  request<Execution>("/v1/commands", {
    method: "POST",
    body: JSON.stringify({ text, sessionId: "local", requestedBy: "text" }),
  });

export const approveExecution = (id: string) =>
  request<Execution>(`/v1/executions/${id}/approve`, { method: "POST" });

export const cancelExecution = (id: string) =>
  request<Execution>(`/v1/executions/${id}/cancel`, { method: "POST" });
