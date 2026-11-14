import { useCallback, useEffect, useRef, useState } from "react";
import {
  approveExecution,
  cancelExecution,
  fetchExecutions,
  fetchTools,
  runCommand,
} from "./api";
import type { Execution, NumaEvent, Tool } from "./types";

export interface GatewayState {
  tools: Tool[];
  executions: Execution[];
  events: NumaEvent[];
  connected: boolean;
  ready: boolean;
  run: (text: string) => Promise<void>;
  approve: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useGateway(): GatewayState {
  const [tools, setTools] = useState<Tool[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [events, setEvents] = useState<NumaEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  const refresh = useCallback(async () => {
    const [nextTools, nextExecutions] = await Promise.all([
      fetchTools(),
      fetchExecutions(),
    ]);
    setTools(nextTools);
    setExecutions(nextExecutions);
    setReady(true);
  }, []);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh().catch(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let disposed = false;

    const connect = () => {
      socket = new WebSocket(`${scheme}://${location.host}/v1/events`);

      socket.onopen = () => setConnected(true);

      socket.onmessage = (message) => {
        let event: NumaEvent;
        try {
          event = JSON.parse(String(message.data)) as NumaEvent;
        } catch {
          return;
        }
        setEvents((previous) => [event, ...previous].slice(0, 80));
        if (event.executionId) void refreshRef.current().catch(() => {});
      };

      socket.onerror = () => socket?.close();

      socket.onclose = () => {
        setConnected(false);
        if (!disposed) retryTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  const run = useCallback(
    async (text: string) => {
      await runCommand(text);
      await refresh();
    },
    [refresh],
  );

  const approve = useCallback(
    async (id: string) => {
      await approveExecution(id);
      await refresh();
    },
    [refresh],
  );

  const cancel = useCallback(
    async (id: string) => {
      await cancelExecution(id);
      await refresh();
    },
    [refresh],
  );

  return { tools, executions, events, connected, ready, run, approve, cancel, refresh };
}
