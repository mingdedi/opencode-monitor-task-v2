// 投递链
// DeliverChain：per-task Promise 串行链保序（——wake → 尾批 flush → lifecycle
// 严格序）；单 job 失败不阻断后续 job（保序但隔离失败）。
// deliverNotification：resolveTarget 现读 service.json→ sendSynthetic
// （delivery 显式传，CONTRACT.md 实测：省略时服务端默认 steer）→ retryable 类失败
// 指数退避重试 500ms/2s/8s（上限 3 次）→ session-not-found / invalid 不重试即返回
// 。
// 重试耗尽 → pending 落盘重投（本版计 drop + 上层日志）。

import type { Delivery, PathEnv } from "@omt/shared";
import { resolveTarget, sendSynthetic, type OcDeps, type OpencodeRegistry } from "./opencode.ts";

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 2000, 8000];

// ---------------------------------------------------------------------------
// per-task 串行链

export class DeliverChain {
  private tail: Promise<unknown> = Promise.resolve();
  private depth_ = 0;

  /** 链上在途 job 数（调用方据此执行 pending 上限丢弃，防内存膨胀） */
  get depth(): number {
    return this.depth_;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.tail.then(job, job); // 前序失败不阻断后续：保序但隔离失败
    this.tail = p.then(
      () => undefined,
      () => undefined,
    );
    this.depth_++;
    const settle = (): void => {
      this.depth_--;
    };
    p.then(settle, settle);
    return p;
  }
}

// ---------------------------------------------------------------------------
// 单条通知投递（resolveTarget → synthetic → 退避重试）

export interface DeliverJob {
  sessionId: string;
  opencodePort: number;
  /** 信封全文（buildEnvelope 产物，转义已在信封层完成） */
  text: string;
  /** wake：任务参数；lifecycle：恒 "queue" */
  delivery: Delivery;
  /** 幂等 id：重试必须复用同 id（CONTRACT.md 实测真去重） */
  idempotencyId: string;
}

export interface DeliverDeps {
  ocRegistry: OpencodeRegistry;
  env: PathEnv;
  ocDeps?: OcDeps;
  /** 重试间隔（默认 500/2s/8s；单测注入 [0,0,0] 加速） */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export type DeliverOutcome =
  | { ok: true; messageId?: string }
  | { ok: false; kind: "session-not-found" | "invalid" | "exhausted"; detail: string };

export async function deliverNotification(deps: DeliverDeps, job: DeliverJob): Promise<DeliverOutcome> {
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ocDeps = deps.ocDeps ?? {};
  let lastDetail = "no attempt made";
  for (let attempt = 0; ; attempt++) {
    // 每次投递前现读目标（opencode 重启后 url/password 都会变）
    const target = await resolveTarget(deps.ocRegistry, job.opencodePort, deps.env, ocDeps);
    if (target.ok) {
      const r = await sendSynthetic(
        target.svc,
        {
          sessionId: job.sessionId,
          text: job.text,
          delivery: job.delivery,
          id: job.idempotencyId,
        },
        ocDeps,
      );
      if (r.ok) return { ok: true, messageId: r.messageId };
      if (r.failure === "session-not-found") {
        return { ok: false, kind: "session-not-found", detail: r.detail ?? "" };
      }
      if (r.failure === "invalid") {
        return { ok: false, kind: "invalid", detail: r.detail ?? "" };
      }
      // retryable | unauthorized：401 多为 password 轮换，重试时现读 service.json 自愈
      lastDetail = r.detail ?? "retryable failure";
    } else {
      // 目标暂不可达（重启中/stale）：同样给退避重试机会
      lastDetail = `${target.code}: ${target.reason}`;
    }
    if (attempt >= delays.length) return { ok: false, kind: "exhausted", detail: lastDetail };
    await sleep(delays[attempt]!);
  }
}
