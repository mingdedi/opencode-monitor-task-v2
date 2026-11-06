// opencode 共享后台服务的 service.json 读取与鉴权
// url/password 每次 opencode service 重启都会变——每次使用前现读，绝不缓存，凭证永不落盘
// 服务端 opencode.ts 的注册表以此为基础（--opencode-state 多条目场景）

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { envFromProcess, type PathEnv } from "./paths.ts";

export interface OpencodeService {
  id?: string;
  version?: string;
  url: string;
  pid?: number;
  password: string;
}

/** opencode service.json 路径（默认共享服务条目） */
export function opencodeServicePath(env: PathEnv = envFromProcess()): string {
  const stateHome =
    env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/")
      ? env.XDG_STATE_HOME
      : env.HOME && env.HOME.startsWith("/")
        ? path.join(env.HOME, ".local", "state")
        : path.join(homedir(), ".local", "state");
  return path.join(stateHome, "opencode", "service.json");
}

/** 现读 service.json（入口唯一，供脚本与服务端共用） */
export function readOpencodeService(env: PathEnv = envFromProcess(), filePath?: string): OpencodeService {
  const svc = JSON.parse(readFileSync(filePath ?? opencodeServicePath(env), "utf8")) as OpencodeService;
  if (!svc.url || !svc.password) {
    throw new Error("malformed opencode service.json: url/password missing");
  }
  return svc;
}

/** Basic auth 头（username 固定 "opencode"，官方文档化行为） */
export function opencodeAuthHeader(svc: OpencodeService): string {
  return "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64");
}
