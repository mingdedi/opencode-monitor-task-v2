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

/** 构造可选项（fetch 注入便于 TUI/测试替换传输层，默认全局 fetch；
 *  signal 外部取消——插件工具 execute 的 context.signal 穿透，PLUGIN-PLAN §四纪律 5） */
export interface MonitorClientOptions {
  fetchImpl?: typeof fetch;
  /** 外部取消信号：与每次请求的内部超时并存（任一触发即中止该次 fetch） */
  signal?: AbortSignal;
}

export class MonitorClient {
  private readonly auth: string;
  private readonly fetchImpl: typeof fetch;
  private readonly externalSignal: AbortSignal | undefined;

  constructor(
    readonly baseUrl: string,
    password: string,
    opts: MonitorClientOptions = {},
  ) {
    this.auth = "Basic " + Buffer.from(`monitor:${password}`).toString("base64");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.externalSignal = opts.signal;
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    // 外部 signal 桥接（超时与取消并存）：手动 addEventListener 而非 AbortSignal.any——
    // 后者需 node ≥ 20.3，README 承诺 ≥ 20
    const ext = this.externalSignal;
    const onAbort = (): void => ctrl.abort();
    if (ext) {
      if (ext.aborted) ctrl.abort(); // 注册前已取消
      else ext.addEventListener("abort", onAbort);
    }
    try {
      const res = await this.fetchImpl(this.baseUrl + path, {
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
      ext?.removeEventListener("abort", onAbort);
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
