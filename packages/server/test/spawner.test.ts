// spawner 单测：wrapper 四态、detached 存活、双因子探活、killTree
// 真实进程（无 mock）——进程语义必须真机验证；任务目录走隔离 XDG
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import type { PathEnv } from "@omt/shared";
import { initTaskDir, readExitFile, type TaskFilePaths } from "../src/taskstore.ts";
import {
  exitCodeFromRaw,
  isTaskProcessAlive,
  killTree,
  readProcStartTime,
  spawnTask,
  statAfterComm,
  wrapperScript,
  type SpawnedTask,
} from "../src/spawner.ts";

let root: string;
let env: PathEnv;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "omt-spawner-"));
  env = { XDG_STATE_HOME: `${root}/state`, XDG_DATA_HOME: `${root}/data` };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
interface TestTask {
  id: string;
  t: SpawnedTask;
  paths: TaskFilePaths;
  log: () => string;
}

function newTask(command: string): TestTask {
  const id = `mon_t${Date.now().toString(36)}${(seq++).toString(36)}`;
  const paths = initTaskDir(env, id);
  const t = spawnTask(paths, command, { cwd: root });
  return { id, t, paths, log: () => readFileSync(paths.log, "utf8") };
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

/** 等任务"就位"：spawn 返回时可能尚未 execve——信号测试必须等 wrapper 装好 trap 再动手。
 *  就绪判据 = 命令自身的 echo 标记落地（标记写在 trap 行之后，标记出现即 trap 已生效）。 */
async function taskReady(task: TestTask, marker: string): Promise<void> {
  assert.ok(
    await waitFor(() => task.log().includes(marker), 3000),
    `task not ready within 3s (marker=${marker})`,
  );
}

const exited = (task: TestTask): string | null => readExitFile(env, task.id);

// ---------------------------------------------------------------------------
// /proc stat 解析（纯函数）

test("statAfterComm：comm 含空格与括号也取对字段（最后一个 ')' 之后）", () => {
  // 真 stat 形状：pid (comm) state ppid ... starttime（字段22）
  const line = "1234 (a (weird) name) S 1 1234 1234 0 -1 4194304 100 0 0 0 5 3 0 0 20 0 1 0 987654 0";
  const f = statAfterComm(line);
  assert.equal(f[0], "S"); // 字段3 state
  assert.equal(f[19], "987654"); // 字段22 starttime
});

test("wrapperScript：trap 前置 + 命令原样作为脚本体；exit 路径不进脚本文本", () => {
  const s = wrapperScript("echo 'hi' & true");
  assert.ok(s.startsWith("trap '"));
  assert.ok(s.includes("OMT_EXIT_FILE"));
  assert.ok(s.includes("trap 'exit 143' TERM")); // 信号归一 trap（实测：无它则组 TERM 记成 "0"）
  assert.ok(s.endsWith("echo 'hi' & true"));
});

test("wrapper 信号归一：命令子进程自杀 SIGKILL → \"signal:9\"（不依赖组杀）", async () => {
  const task = newTask("sh -c 'kill -9 $$'");
  assert.ok(await waitFor(() => exited(task) === "signal:9"), `exit=${exited(task)}`);
});

test("spawn 失败防御：解释器不可用时同步报错且不崩进程（error 事件被吞）", async () => {
  const paths = initTaskDir(env, `mon_t${Date.now().toString(36)}${(seq++).toString(36)}x`);
  // PATH 清空 → bash 不可用。失败有两条路径（实测）：uv_spawn 同步抛 ENOENT；
  // 或返回 pid undefined（走 no pid 检查）+ 异步 emit('error')——后者若无监听将
  // uncaughtException 崩掉服务端（review 修复：on("error") no-op 吞掉）。两种都接受。
  assert.throws(
    () => spawnTask(paths, "echo hi", { cwd: root, env: { PATH: "" } }),
    (err: unknown) => {
      const e = err as NodeJS.ErrnoException;
      return e.code === "ENOENT" || /no pid/.test(e.message ?? "");
    },
    "expected ENOENT or no-pid error",
  );
  await new Promise((r) => setTimeout(r, 200)); // 留出异步 error 窗口——若未被吞，此处到不了
});

// ---------------------------------------------------------------------------
// wrapper 四态：exit 0 / exit 7 / 信号 TERM / SIGKILL（无文件 → unknown）

test("wrapper 态①：正常退出 0 → exit 文件 \"0\"，stdout 落 log；权限 0600", async () => {
  const task = newTask("echo hello-stage-c; exit 0");
  // chmod 600 与 printf 同在 EXIT trap 内但分两步——内容就绪 ≠ 权限就绪（node 20 实测
  // 稳定暴露此窗口），权限断言并入轮询判据消除竞态
  assert.ok(
    await waitFor(
      () =>
        exited(task) === "0" &&
        (() => {
          try {
            return (statSync(task.paths.exit).mode & 0o777) === 0o600;
          } catch {
            return false;
          }
        })(),
    ),
    `exit=${exited(task)} mode=${(() => {
      try {
        return (statSync(task.paths.exit).mode & 0o777).toString(8);
      } catch {
        return "n/a";
      }
    })()}`,
  );
  assert.ok(task.log().includes("hello-stage-c"));
});

test("wrapper 态②：非零退出 7 → exit 文件 \"7\"", async () => {
  const task = newTask("echo out; echo err 1>&2; exit 7");
  assert.ok(await waitFor(() => exited(task) === "7"), `exit=${exited(task)}`);
});

test("wrapper 态③：killTree TERM → exit 文件 \"signal:15\"，返回档位 term，组消亡", async () => {
  const task = newTask("echo READY; sleep 30");
  await taskReady(task, "READY");
  const tier = await killTree(task.t.pgid);
  assert.equal(tier, "term");
  assert.ok(await waitFor(() => exited(task) === "signal:15"), `exit=${exited(task)}`);
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid: task.t.pid, startTime: null })));
});

test("wrapper 态④：抗 TERM（trap '' TERM + exec）→ killTree 升级 KILL；exec 丢弃 EXIT trap → 无文件 → unknown", async () => {
  const task = newTask("trap '' TERM; echo READY; exec sleep 30");
  await taskReady(task, "READY"); // echo 在 trap 之后：标记出现即 TERM 忽略已生效（exec 前后皆无竞态）
  const tier = await killTree(task.t.pgid);
  assert.equal(tier, "kill");
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid: task.t.pid, startTime: null })));
  await new Promise((r) => setTimeout(r, 150)); // 留出"本不该发生的写入"窗口
  assert.equal(exited(task), null, "exec 后 EXIT trap 已丢弃，不应有 exit 文件");
  assert.equal(exitCodeFromRaw(exited(task)), "unknown");
});

test("wrapper 态④附：整组 SIGKILL 直杀 → 无 exit 文件 → exitCodeFromRaw 判 unknown", async () => {
  const task = newTask("echo READY; sleep 30");
  await taskReady(task, "READY");
  process.kill(-task.t.pgid, "SIGKILL");
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid: task.t.pid, startTime: null })));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(exited(task), null);
  assert.equal(exitCodeFromRaw(exited(task)), "unknown");
  assert.equal(exitCodeFromRaw(""), "unknown"); // 空文件（写入截断）同样判 unknown，不透传空串
});

// ---------------------------------------------------------------------------
// 文件即管道：stdout+stderr 合并、父侧放手后任务自然完成

test("stdio 合并：stdout 与 stderr 都落 log", async () => {
  const task = newTask("echo to-out; echo to-err 1>&2; exit 0");
  assert.ok(await waitFor(() => exited(task) === "0"));
  const text = task.log();
  assert.ok(text.includes("to-out") && text.includes("to-err"), text);
});

test("detached 存活：spawn 后父侧即放手，任务自然跑完并写 exit（文件即管道闭环）", async () => {
  const task = newTask("sleep 0.3; exit 0");
  assert.ok(await waitFor(() => exited(task) === "0"), `exit=${exited(task)}`); // 进程已尽职责
  assert.ok(await waitFor(() => !isTaskProcessAlive({ pid: task.t.pid, startTime: null })));
});

// ---------------------------------------------------------------------------
// 双因子：pid 复用防御

test("双因子：starttime 不匹配（模拟 pid 复用）→ 按死；匹配/单因子降级 → 活", async () => {
  const task = newTask("echo READY; sleep 30");
  await taskReady(task, "READY");
  try {
    if (process.platform === "linux") {
      assert.notEqual(task.t.procStartTime, null, "Linux 下应读到 starttime");
      assert.equal(isTaskProcessAlive({ pid: task.t.pid, startTime: task.t.procStartTime }), true);
      assert.equal(isTaskProcessAlive({ pid: task.t.pid, startTime: task.t.procStartTime! + 1 }), false);
    }
    assert.equal(isTaskProcessAlive({ pid: task.t.pid, startTime: null }), true); // 单因子降级
    await killTree(task.t.pgid);
    assert.ok(await waitFor(() => !isTaskProcessAlive({ pid: task.t.pid, startTime: null })));
  } finally {
    await killTree(task.t.pgid).catch(() => {});
  }
});

test("readProcStartTime：不存在的 pid 返回 null 而非误报", () => {
  assert.equal(readProcStartTime(-1), null);
  assert.equal(readProcStartTime(4_000_000), null); // pid_max 空洞
});

// ---------------------------------------------------------------------------
// killTree 分支逻辑（注入 sleep 加速；信号路径用真实进程）

test("killTree：组已消失 → term（无需动武）", async () => {
  const task = newTask("exit 0");
  assert.ok(await waitFor(() => exited(task) === "0"));
  assert.equal(await killTree(task.t.pgid), "term");
});

test("killTree：TERM 后组消失 → term（注入探测，不升级 KILL；信号拦截记录，不向凭空 pgid 真发）", async () => {
  const fired: string[] = [];
  const origKill = process.kill.bind(process);
  (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: string | number) => {
    fired.push(`${pid}:${String(sig)}`);
    if (pid === -424242) return true; // 拦截凭空 pgid：只记录不真发（防误杀无关进程组）
    return origKill(pid, sig as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    const tier = await killTree(424242, { sleep: async () => {}, groupExists: () => false });
    assert.equal(tier, "term");
    assert.ok(fired.some((f) => f.endsWith(":SIGTERM")), `TERM 应已发出: ${fired.join(" ")}`);
    assert.ok(!fired.some((f) => f.endsWith(":SIGKILL")), `不应升级 KILL: ${fired.join(" ")}`);
  } finally {
    (process as unknown as { kill: unknown }).kill = origKill;
  }
});

test("killTree：TERM 后组仍在 → 升级 KILL（真实抗 TERM 进程验证信号确实发出）", async () => {
  const task = newTask("trap '' TERM; echo READY; exec sleep 30");
  await taskReady(task, "READY");
  const fired: string[] = [];
  const origKill = process.kill.bind(process);
  (process as unknown as { kill: unknown }).kill = ((pid: number, sig?: string | number) => {
    fired.push(`${pid}:${String(sig)}`);
    return origKill(pid, sig as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    const tier = await killTree(task.t.pgid, { sleep: async () => {} });
    assert.equal(tier, "kill");
    assert.ok(fired.some((f) => f.endsWith(":SIGKILL")), `signals=${fired.join(" ")}`);
  } finally {
    (process as unknown as { kill: unknown }).kill = origKill;
    await killTree(task.t.pgid).catch(() => {});
  }
});
