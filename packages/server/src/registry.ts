// 任务注册表（PLAN §2.4/§2.10 / §6.1；SERVER-PLAN 阶段 D 薄版）
// 纯簿记与聚合（PLAN §6.2 模块纪律：严禁 spawn/流处理/投递细节）：
//   阶段 D：内存 Map + PublicInfo 聚合视图 + alive 计数（health 数据源）
//   阶段 F：每 session ≤16 存活上限 + 终态 200 驱逐最旧
//   阶段 G：TaskStore 合并视图（parked 无 Monitor 实例，从 store 出）

import type { PublicInfo, TaskState } from "@omt/shared";

/** registry 只认这个最小视图——Monitor 满足之；测试可轻量 stub */
export interface TaskView {
  id: string;
  toPublicInfo(): PublicInfo;
}

const ALIVE_STATES: ReadonlySet<TaskState> = new Set(["starting", "running", "idle"]);

export function isAliveState(s: TaskState): boolean {
  return ALIVE_STATES.has(s);
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskView>();

  add(t: TaskView): void {
    this.tasks.set(t.id, t);
  }

  get(id: string): TaskView | undefined {
    return this.tasks.get(id);
  }

  get size(): number {
    return this.tasks.size;
  }

  aliveCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (isAliveState(t.toPublicInfo().state)) n++;
    }
    return n;
  }

  /** 聚合视图（TUI/工具列表数据源）；sessionId 过滤（PLAN §2.2 ?session_id=） */
  listInfos(sessionId?: string): PublicInfo[] {
    const out: PublicInfo[] = [];
    for (const t of this.tasks.values()) {
      const info = t.toPublicInfo();
      if (sessionId === undefined || info.session_id === sessionId) out.push(info);
    }
    return out.sort((a, b) => a.started_at - b.started_at);
  }
}
