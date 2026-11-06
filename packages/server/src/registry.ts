// 任务注册表
// 纯簿记与聚合：
//   内存 Map + PublicInfo 聚合视图 + alive 计数（health 数据源）；
//   每 session ≤16 存活上限（createTask fail fast 查询）+ 终态 200 驱逐最旧；
//   TaskStore 合并视图（parked 无 Monitor 实例，从 store 出）

import { LIMITS, type PublicInfo, type TaskState } from "@omt/shared";

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
    this.evictTerminalIfNeeded();
  }

  get(id: string): TaskView | undefined {
    return this.tasks.get(id);
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
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

  /** 每 session 存活任务数 */
  aliveCountForSession(sessionId: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      const info = t.toPublicInfo();
      if (info.session_id === sessionId && isAliveState(info.state)) n++;
    }
    return n;
  }

  /** 聚合视图（TUI/工具列表数据源）；sessionId 过滤 */
  listInfos(sessionId?: string): PublicInfo[] {
    const out: PublicInfo[] = [];
    for (const t of this.tasks.values()) {
      const info = t.toPublicInfo();
      if (sessionId === undefined || info.session_id === sessionId) out.push(info);
    }
    return out.sort((a, b) => a.started_at - b.started_at);
  }

  /** 终态驱逐（上限 200，驱逐最旧——registry 内存簿记上限，非硬实时；
   *  惰性触发于 add：终态由活任务死亡产生，短暂超限无害，下次创建即清扫。
   *  只动内存——TaskStore 目录清理由 sweeper TTL 负责） */
  private evictTerminalIfNeeded(): void {
    const terminal: Array<{ id: string; startedAt: number }> = [];
    for (const t of this.tasks.values()) {
      const info = t.toPublicInfo();
      if (!isAliveState(info.state)) terminal.push({ id: t.id, startedAt: info.started_at });
    }
    const toEvict = terminal.length - LIMITS.registryMaxTerminal;
    if (toEvict <= 0) return;
    terminal.sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < toEvict; i++) this.tasks.delete(terminal[i]!.id);
  }
}
