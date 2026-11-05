import assert from "node:assert/strict";
import { test } from "node:test";
import { createFeed } from "../src/tui/feed.ts";
import type { FeedDeps, FeedSnapshot } from "../src/tui/feed.ts";
import type { PublicInfo, ServiceFile } from "../packages/shared/src/types.ts";

const NOW = 1_800_000_000_000;

function svcFile(over: Partial<ServiceFile> = {}): ServiceFile {
  return {
    id: "srv-1",
    version: "2.0.0",
    url: "http://127.0.0.1:49000",
    pid: 999,
    password: "pw1",
    started_at: 1,
    ...over,
  };
}

function sampleTasks(): PublicInfo[] {
  return [
    {
      id: "mon_ab12cd34",
      description: null,
      state: "running",
      session_id: "ses_cur",
      opencode_port: 49374,
      directory: "/abs",
      command: "npm run watch",
      pattern: null,
      wake_mode: "all",
      delivery: "queue",
      coalesce_ms: 500,
      max_events: 50,
      idle_timeout_ms: 300000,
      idle_deadline: null,
      grace_deadline: null,
      started_at: NOW - 1000,
      pid: 1,
      lines_scanned: 1,
      lines_matched: 0,
      events_sent: 0,
      events_dropped: 0,
      exit_info: null,
      log_bytes: 0,
      last_offset: 0,
      updated_at: NOW,
    },
  ];
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const okTasks = () => Promise.resolve(new Response(JSON.stringify(sampleTasks()), { status: 200 }));

function makeDeps(over: Partial<FeedDeps> = {}): { deps: FeedDeps; snaps: FeedSnapshot[] } {
  const snaps: FeedSnapshot[] = [];
  const deps: FeedDeps = {
    now: () => NOW,
    readServiceFile: () => svcFile(),
    fetchImpl: fakeFetch(okTasks).fn,
    isPidAlive: () => true,
    onSnapshot: (snap) => snaps.push(snap),
    ...over,
  };
  return { deps, snaps };
}

test("no service file: offline without touching the network", async () => {
  const fetcher = fakeFetch(okTasks);
  const { deps, snaps } = makeDeps({ readServiceFile: () => null, fetchImpl: fetcher.fn });
  await createFeed(deps).tick();
  assert.equal(fetcher.calls.length, 0);
  assert.deepEqual(snaps, [
    { status: { kind: "offline", reason: "no-service-file" }, tasks: [], fetchedAt: null },
  ]);
});

test("online: tasks arrive with auth header and fetchedAt", async () => {
  const fetcher = fakeFetch(okTasks);
  const { deps, snaps } = makeDeps({ fetchImpl: fetcher.fn });
  await createFeed(deps).tick();
  assert.equal(fetcher.calls.length, 1);
  assert.equal(fetcher.calls[0]!.url, "http://127.0.0.1:49000/api/tasks");
  const auth = fetcher.calls[0]!.init?.headers as Record<string, string>;
  assert.equal(auth["authorization"], "Basic " + Buffer.from("monitor:pw1").toString("base64"));
  assert.equal(snaps.length, 1);
  assert.deepEqual(snaps[0]!.status, { kind: "online" });
  assert.equal(snaps[0]!.tasks.length, 1);
  assert.equal(snaps[0]!.fetchedAt, NOW);
});

test("network failure with dead pid: offline pid-dead", async () => {
  const { deps, snaps } = makeDeps({
    fetchImpl: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))).fn,
    isPidAlive: () => false,
  });
  await createFeed(deps).tick();
  assert.deepEqual(snaps, [{ status: { kind: "offline", reason: "pid-dead" }, tasks: [], fetchedAt: null }]);
});

test("network failure with live pid: unreachable with diagnostics", async () => {
  const { deps, snaps } = makeDeps({
    fetchImpl: fakeFetch(() => Promise.reject(new TypeError("connect ECONNREFUSED"))).fn,
    isPidAlive: () => true,
  });
  await createFeed(deps).tick();
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]!.status.kind, "unreachable");
  assert.match((snaps[0]!.status as { detail: string }).detail, /ECONNREFUSED/);
  assert.match((snaps[0]!.status as { detail: string }).detail, /pid 999 alive/);
});

test("API error (401) with live pid: unreachable http status", async () => {
  const { deps, snaps } = makeDeps({
    fetchImpl: fakeFetch(() => Promise.resolve(new Response("{}", { status: 401 }))).fn,
  });
  await createFeed(deps).tick();
  assert.equal(snaps[0]!.status.kind, "unreachable");
  assert.match((snaps[0]!.status as { detail: string }).detail, /http 401/);
});

test("undici-style fetch failure surfaces its cause chain", async () => {
  // 真实 undici 网络错误的 message 只有 "fetch failed"，原因在 cause 里
  const err = new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:49000") });
  const { deps, snaps } = makeDeps({
    fetchImpl: fakeFetch(() => Promise.reject(err)).fn,
  });
  await createFeed(deps).tick();
  assert.equal(snaps[0]!.status.kind, "unreachable");
  assert.match((snaps[0]!.status as { detail: string }).detail, /ECONNREFUSED/);
});

test("service.json with non-positive pid is treated as absent", async () => {
  const fetcher = fakeFetch(okTasks);
  const { deps, snaps } = makeDeps({
    readServiceFile: () => svcFile({ pid: 0 }),
    fetchImpl: fetcher.fn,
  });
  await createFeed(deps).tick();
  assert.equal(fetcher.calls.length, 0, "no HTTP attempt on invalid pid");
  assert.deepEqual(snaps[0]!.status, { kind: "offline", reason: "no-service-file" });
});

test("service.json rotation (url+password change) rebuilds the client", async () => {
  const fetcher = fakeFetch(okTasks);
  let svc: ServiceFile | null = svcFile();
  const { deps } = makeDeps({ readServiceFile: () => svc, fetchImpl: fetcher.fn });
  const feed = createFeed(deps);
  await feed.tick();
  assert.equal(fetcher.calls[0]!.url, "http://127.0.0.1:49000/api/tasks");

  svc = svcFile({ url: "http://127.0.0.1:49111", password: "pw2" });
  await feed.tick();
  assert.equal(fetcher.calls[1]!.url, "http://127.0.0.1:49111/api/tasks");
  const auth2 = fetcher.calls[1]!.init?.headers as Record<string, string>;
  assert.equal(auth2["authorization"], "Basic " + Buffer.from("monitor:pw2").toString("base64"));
});

test("client is discarded after pid-dead so the next tick rediscovers", async () => {
  let alive = true;
  const fetcher = fakeFetch(() =>
    alive ? okTasks() : Promise.reject(new TypeError("fetch failed")),
  );
  let svc: ServiceFile | null = svcFile();
  const { deps, snaps } = makeDeps({
    readServiceFile: () => svc,
    fetchImpl: fetcher.fn,
    isPidAlive: () => alive,
  });
  const feed = createFeed(deps);
  await feed.tick();
  assert.equal(snaps[0]!.status.kind, "online");

  // 服务端死亡：service.json 变 stale（pid 死）
  alive = false;
  svc = svcFile({ pid: 777 });
  await feed.tick();
  assert.deepEqual(snaps[1]!.status, { kind: "offline", reason: "pid-dead" });

  // 新服务端接管（新 url/password）→ 下一轮自愈回 online
  alive = true;
  svc = svcFile({ url: "http://127.0.0.1:49222", pid: 888, password: "pw3" });
  await feed.tick();
  assert.deepEqual(snaps[2]!.status, { kind: "online" });
  assert.equal(fetcher.calls[2]!.url, "http://127.0.0.1:49222/api/tasks");
});

test("concurrent ticks share one inflight request", async () => {
  let release: (() => void) | undefined;
  const fetcher = fakeFetch(
    () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response("[]", { status: 200 }));
      }),
  );
  const { deps } = makeDeps({ fetchImpl: fetcher.fn });
  const feed = createFeed(deps);
  const first = feed.tick();
  const second = feed.tick();
  assert.equal(first, second, "inflight tick is deduplicated");
  release!();
  await first;
  assert.equal(fetcher.calls.length, 1);
});
