// 命令与参数校验（PLAN §3.3 v1 规则全套 + 参数范围）——纯函数
// 注意：这是防呆不是安全边界——服务端本就以用户权限执行任意 bash，与 agent 的 shell 工具同级（PLAN §4）
//
// 规则：
//   1. 尾部 `&` 剥离（引号外的单个尾部 &）
//   2. 孤立 `&` 拒绝（`&&` / `2>&1` / `>&2` / `&>file` / 引号内豁免）
//   3. `$(...)`、反引号拒绝（单引号内豁免；双引号内仍展开，同样拒绝）
//   4. `<(...)`、`>(...)` 拒绝（仅引号外；双引号内是字面量）

import type { CreateTaskInput, Delivery, WakeMode } from "./types.ts";
import { LIMITS } from "./types.ts";

export interface CommandCheck {
  ok: boolean;
  reason?: string;
  /** 剥离尾部后台 & 后待执行的命令；ok 时有效 */
  command: string;
}

interface ScanResult {
  violations: string[];
  /** 末尾孤立 & 是否在引号外（候选剥离点） */
  trailingAmpUnquoted: boolean;
}

function scan(cmd: string): ScanResult {
  const violations: string[] = [];
  let state: "normal" | "single" | "double" = "normal";
  let i = 0;
  const n = cmd.length;

  while (i < n) {
    const ch = cmd[i]!;
    if (state === "single") {
      if (ch === "'") state = "normal";
      i++;
      continue;
    }
    if (state === "double") {
      if (ch === "\\") {
        // 双引号内 \ 仅转义 " $ ` \，其余为字面量
        const next = cmd[i + 1];
        if (next === '"' || next === "$" || next === "`" || next === "\\") i += 2;
        else i++;
        continue;
      }
      if (ch === '"') {
        state = "normal";
        i++;
        continue;
      }
      if (ch === "`") {
        violations.push("backtick command substitution");
        i++;
        continue;
      }
      if (ch === "$" && cmd[i + 1] === "(") {
        violations.push("$(...) command substitution");
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    // normal
    switch (ch) {
      case "\\":
        i += 2; // 转义下一字符
        continue;
      case "'":
        state = "single";
        i++;
        continue;
      case '"':
        state = "double";
        i++;
        continue;
      case "`":
        violations.push("backtick command substitution");
        i++;
        continue;
      case "$":
        if (cmd[i + 1] === "(") {
          violations.push("$(...) command substitution");
          i += 2;
          continue;
        }
        i++;
        continue;
      case "<":
        if (cmd[i + 1] === "(") {
          violations.push("<(...) process substitution");
          i += 2;
          continue;
        }
        i++;
        continue;
      case ">":
        if (cmd[i + 1] === "(") {
          violations.push(">(...) process substitution");
          i += 2;
          continue;
        }
        i++;
        continue;
      case "&": {
        const next = cmd[i + 1];
        const prev = lastNonSpace(cmd, i);
        if (next === "&") {
          if (isTrailingAt(cmd, i + 1)) {
            violations.push("incomplete && at end of command");
          }
          i += 2; // && 逻辑与
          continue;
        }
        if (next === ">" || prev === ">") {
          i++; // &> / >& 重定向族
          continue;
        }
        if (isTrailingAt(cmd, i)) {
          return { violations, trailingAmpUnquoted: true };
        }
        violations.push("bare & (background execution not allowed)");
        i++;
        continue;
      }
      default:
        i++;
    }
  }
  return { violations, trailingAmpUnquoted: false };
}

function lastNonSpace(cmd: string, before: number): string | undefined {
  for (let j = before - 1; j >= 0; j--) {
    if (cmd[j] !== " " && cmd[j] !== "\t") return cmd[j];
  }
  return undefined;
}

/** cmd[i] 之后是否全是空白（即该 & 是行尾 &） */
function isTrailingAt(cmd: string, i: number): boolean {
  return cmd.slice(i + 1).trim() === "";
}

export function checkCommand(raw: string): CommandCheck {
  let cmd = raw.trim();
  if (cmd === "") {
    return { ok: false, reason: "command is empty", command: "" };
  }
  // 尾部单个 & 剥离（循环防御 `sleep 5 & &`；&& 结尾属语法不完整，走违规路径）
  for (;;) {
    const trimmed = cmd.trimEnd();
    if (trimmed.endsWith("&") && !trimmed.endsWith("&&")) {
      const probe = scan(trimmed);
      if (probe.trailingAmpUnquoted) {
        cmd = trimmed.slice(0, -1).trimEnd();
        continue;
      }
      // 末 & 在引号内（如 echo "x&"）：不剥离，交由完整扫描裁决
    }
    break;
  }
  if (cmd === "") {
    return { ok: false, reason: "command is empty after stripping trailing &", command: "" };
  }
  const result = scan(cmd);
  if (result.violations.length > 0) {
    return { ok: false, reason: result.violations[0], command: cmd };
  }
  return { ok: true, command: cmd };
}

/** 发现流程版本兼容判定：major.minor 相等即复用，patch 视为兼容（SERVER-PLAN §三-3） */
export function versionCompatible(mine: string, running: string): boolean {
  const a = mine.split(".");
  const b = running.split(".");
  return a[0] === b[0] && a[1] === b[1];
}

// ---------------------------------------------------------------------------
// CreateTaskInput 校验（服务端 POST /api/tasks 入口；白名单/session 存活校验在 opencode 层）

export interface ParamViolation {
  field: string;
  message: string;
}

/** validateCreateInput 产物：可选参数已全部解析默认值——下游无需再判 undefined */
export interface ResolvedCreateInput {
  command: string;
  opencode_port: number;
  session_id: string;
  description?: string;
  pattern?: string;
  wake_mode: WakeMode;
  delivery: Delivery;
  coalesce_ms: number;
  max_events: number;
  idle_timeout_ms: number;
  directory?: string;
}

/** discriminated union（§6.2 纪律）：ok true 时 value 必在 */
export type CreateValidation =
  | { ok: true; violations: []; value: ResolvedCreateInput }
  | { ok: false; violations: ParamViolation[] };

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

export function validateCreateInput(input: unknown): CreateValidation {
  const v: ParamViolation[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, violations: [{ field: "body", message: "JSON object required" }] };
  }
  const raw = input as Record<string, unknown>;

  // command（必填）；保存剥离后台 & 后的命令作为下游执行命令
  let command: string | undefined;
  if (typeof raw["command"] !== "string" || raw["command"].trim() === "") {
    v.push({ field: "command", message: "non-empty string required" });
  } else {
    const check = checkCommand(raw["command"]);
    if (!check.ok) v.push({ field: "command", message: check.reason ?? "invalid command" });
    else command = check.command;
  }

  // opencode_port（必填，白名单校验在服务端 opencode 层）
  if (!isInt(raw["opencode_port"]) || raw["opencode_port"] < 1 || raw["opencode_port"] > 65535) {
    v.push({ field: "opencode_port", message: "integer 1-65535 required" });
  }

  // session_id（必填）
  if (typeof raw["session_id"] !== "string" || raw["session_id"] === "") {
    v.push({ field: "session_id", message: "non-empty string required" });
  }

  // description
  if (
    raw["description"] !== undefined &&
    (typeof raw["description"] !== "string" || raw["description"].length > LIMITS.descriptionMaxChars)
  ) {
    v.push({ field: "description", message: `string ≤ ${LIMITS.descriptionMaxChars} chars` });
  }

  // pattern（合法正则；null/空串规范化为未提供）
  const pattern = typeof raw["pattern"] === "string" && raw["pattern"] !== "" ? raw["pattern"] : undefined;
  if (pattern !== undefined) {
    try {
      void new RegExp(pattern);
    } catch (err) {
      v.push({ field: "pattern", message: `invalid regex: ${(err as Error).message}` });
    }
  }

  // wake_mode
  if (raw["wake_mode"] !== undefined && raw["wake_mode"] !== "all" && raw["wake_mode"] !== "pattern") {
    v.push({ field: "wake_mode", message: '"all" | "pattern"' });
  }

  // delivery
  if (raw["delivery"] !== undefined && raw["delivery"] !== "queue" && raw["delivery"] !== "steer") {
    v.push({ field: "delivery", message: '"queue" | "steer"' });
  }

  // coalesce_ms [0, 60000]
  if (
    raw["coalesce_ms"] !== undefined &&
    (!isInt(raw["coalesce_ms"]) || raw["coalesce_ms"] < 0 || raw["coalesce_ms"] > LIMITS.maxCoalesceMs)
  ) {
    v.push({ field: "coalesce_ms", message: `integer 0-${LIMITS.maxCoalesceMs}` });
  }

  // max_events [1, 10000]
  if (
    raw["max_events"] !== undefined &&
    (!isInt(raw["max_events"]) || raw["max_events"] < 1 || raw["max_events"] > LIMITS.maxMaxEvents)
  ) {
    v.push({ field: "max_events", message: `integer 1-${LIMITS.maxMaxEvents}` });
  }

  // idle_timeout_ms [1, 3600000]
  if (
    raw["idle_timeout_ms"] !== undefined &&
    (!isInt(raw["idle_timeout_ms"]) ||
      raw["idle_timeout_ms"] < 1 ||
      raw["idle_timeout_ms"] > LIMITS.maxIdleTimeoutMs)
  ) {
    v.push({ field: "idle_timeout_ms", message: `integer 1-${LIMITS.maxIdleTimeoutMs}` });
  }

  // directory（绝对路径；存在性由服务端异步校验）
  if (raw["directory"] !== undefined && (typeof raw["directory"] !== "string" || !raw["directory"].startsWith("/"))) {
    v.push({ field: "directory", message: "absolute path required" });
  }

  if (v.length > 0) return { ok: false, violations: v };

  const value: ResolvedCreateInput = {
    // checkCommand 剥离尾部 & 后的执行命令（v 非空已提前 return，此处必已赋值）
    command: command!,
    opencode_port: raw["opencode_port"] as number,
    session_id: raw["session_id"] as string,
    description: (raw["description"] as string | undefined) ?? undefined,
    pattern,
    wake_mode: (raw["wake_mode"] as WakeMode | undefined) ?? (pattern ? "pattern" : "all"),
    delivery: (raw["delivery"] as Delivery | undefined) ?? "queue",
    coalesce_ms: (raw["coalesce_ms"] as number | undefined) ?? LIMITS.defaultCoalesceMs,
    max_events: (raw["max_events"] as number | undefined) ?? LIMITS.defaultMaxEvents,
    idle_timeout_ms: (raw["idle_timeout_ms"] as number | undefined) ?? LIMITS.defaultIdleTimeoutMs,
    directory: (raw["directory"] as string | undefined) ?? undefined,
  };
  // 显式 wake_mode="all" + pattern：只统计不过滤（PLAN §3.3）
  return { ok: true, violations: [], value };
}

// ---------------------------------------------------------------------------
// PATCH /api/tasks/:id 校验（阶段 F；当前仅 max_events 可调，PLAN §2.2/§3.4）

/** 与 CreateValidation 同款 discriminated union（§6.2 纪律） */
export type PatchValidation =
  | { ok: true; violations: []; value: { max_events: number } }
  | { ok: false; violations: ParamViolation[] };

export function validatePatchInput(input: unknown): PatchValidation {
  const v: ParamViolation[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, violations: [{ field: "body", message: "JSON object required" }] };
  }
  const raw = input as Record<string, unknown>;
  // 只支持 max_events：其余字段显式拒绝（防呆——传了说明调用方搞错了 PATCH 语义）
  for (const key of Object.keys(raw)) {
    if (key !== "max_events") v.push({ field: key, message: "only max_events is patchable" });
  }
  if (
    raw["max_events"] === undefined ||
    !isInt(raw["max_events"]) ||
    raw["max_events"] < 1 ||
    raw["max_events"] > LIMITS.maxMaxEvents
  ) {
    v.push({ field: "max_events", message: `integer 1-${LIMITS.maxMaxEvents} required` });
  }
  if (v.length > 0) return { ok: false, violations: v };
  return { ok: true, violations: [], value: { max_events: raw["max_events"] as number } };
}
