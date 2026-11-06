// 路径解析单点——全部走环境变量，零硬编码路径，env 可注入便于测试
// state:  $XDG_STATE_HOME/opencode-monitor-task/   （service.json、锁文件、服务端日志）
// data:   $XDG_DATA_HOME/opencode-monitor-task/    （tasks/<id>/{meta.json,log,exit,pending.json}）

export interface PathEnv {
  HOME?: string;
  XDG_STATE_HOME?: string;
  XDG_DATA_HOME?: string;
}

/** 从进程环境构造（服务端/插件运行时用） */
export function envFromProcess(env: NodeJS.ProcessEnv = process.env): PathEnv {
  return {
    HOME: env["HOME"],
    XDG_STATE_HOME: env["XDG_STATE_HOME"],
    XDG_DATA_HOME: env["XDG_DATA_HOME"],
  };
}

const XDG_FALLBACK = { state: ".local/state", data: ".local/share" } as const;

function xdgBase(env: PathEnv, kind: "state" | "data"): string {
  const override = kind === "state" ? env.XDG_STATE_HOME : env.XDG_DATA_HOME;
  if (override && override.startsWith("/")) return override;
  if (env.HOME && env.HOME.startsWith("/")) return `${env.HOME}/${XDG_FALLBACK[kind]}`;
  throw new Error(`cannot resolve XDG ${kind} dir: need absolute XDG_${kind.toUpperCase()}_HOME or HOME`);
}

export function stateDir(env: PathEnv): string {
  return `${xdgBase(env, "state")}/opencode-monitor-task`;
}

export function dataDir(env: PathEnv): string {
  return `${xdgBase(env, "data")}/opencode-monitor-task`;
}

export function serviceFilePath(env: PathEnv): string {
  return `${stateDir(env)}/service.json`;
}

export function lockFilePath(env: PathEnv): string {
  return `${stateDir(env)}/lock`;
}

export function serverLogPath(env: PathEnv): string {
  return `${stateDir(env)}/server.log`;
}

export function tasksDir(env: PathEnv): string {
  return `${dataDir(env)}/tasks`;
}

export function taskDir(env: PathEnv, id: string): string {
  return `${tasksDir(env)}/${id}`;
}
