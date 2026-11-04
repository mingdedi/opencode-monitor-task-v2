// 服务端 HTTP API 客户端（插件端/TUI 用）——fetch 封装 + Basic auth ("monitor:" + password)
// 双端共享契约，与服务端 http.ts 端点一一对应（PLAN §2.2）

import type { ApiError, CreateTaskInput, HealthInfo, PublicInfo } from "./types.ts";

export class MonitorApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
  ) {
    super(`monitor server API ${status}: ${body?.error ?? "unknown"}`);
  }
}

export class MonitorClient {
  private readonly auth: string;

  constructor(
    readonly baseUrl: string,
    password: string,
  ) {
    this.auth = "Basic " + Buffer.from(`monitor:${password}`).toString("base64");
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: this.auth,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let err: ApiError | null = null;
        try {
          err = (await res.json()) as ApiError;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new MonitorApiError(res.status, err);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  health(timeoutMs = 1000): Promise<HealthInfo> {
    return this.request<HealthInfo>("GET", "/api/health", { timeoutMs });
  }

  createTask(input: CreateTaskInput): Promise<PublicInfo> {
    return this.request<PublicInfo>("POST", "/api/tasks", { body: input, timeoutMs: 15_000 });
  }

  listTasks(sessionId?: string): Promise<PublicInfo[]> {
    const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : "";
    return this.request<PublicInfo[]>("GET", `/api/tasks${q}`);
  }

  getTask(id: string): Promise<PublicInfo> {
    return this.request<PublicInfo>("GET", `/api/tasks/${id}`);
  }

  /** 运行时调整（当前仅 max_events） */
  updateTask(id: string, patch: { max_events: number }): Promise<PublicInfo> {
    return this.request<PublicInfo>("PATCH", `/api/tasks/${id}`, { body: patch });
  }

  stopTask(id: string): Promise<PublicInfo> {
    return this.request<PublicInfo>("POST", `/api/tasks/${id}/stop`);
  }

  keepalive(id: string): Promise<PublicInfo> {
    return this.request<PublicInfo>("POST", `/api/tasks/${id}/keepalive`);
  }

  deleteTask(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/tasks/${id}`);
  }

  readLog(id: string, tail = 20): Promise<string> {
    return this.request<string>("GET", `/api/tasks/${id}/log?tail=${tail}`);
  }

  shutdown(killTasks = false): Promise<void> {
    return this.request<void>("POST", "/api/shutdown", { body: { kill_tasks: killTasks } });
  }
}
