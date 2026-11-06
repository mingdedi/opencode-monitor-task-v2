// MonitorClient 外部 signal 传播单测
// 注入 fetchImpl 捕获 fetch 收到的 signal——无网络无真机
import assert from "node:assert/strict";
import { test } from "node:test";
import { MonitorClient } from "../src/client.ts";

function fakeFetch(captured: { signal?: AbortSignal }): typeof fetch {
  return (async (_url: unknown, init?: { signal?: AbortSignal }) => {
    captured.signal = init?.signal;
    // 挂起直到 signal 触发（模拟可中止的长请求）；预 aborted 的 signal 立即拒绝
    //（真 fetch 收到已 aborted 的 signal 即刻 reject——假件对齐该语义）
    return await new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as unknown as typeof fetch;
}

test("外部 signal 中止 → fetch 收到 abort（超时与取消并存）", async () => {
  const captured: { signal?: AbortSignal } = {};
  const ext = new AbortController();
  const client = new MonitorClient("http://127.0.0.1:1", "pw", { fetchImpl: fakeFetch(captured), signal: ext.signal });
  const p = client.health(60_000); // 内部超时放极长——只测外部取消路径
  await new Promise((r) => setTimeout(r, 5));
  ext.abort();
  await assert.rejects(p);
  assert.equal(captured.signal?.aborted, true);
});

test("注册前已取消的 signal → 请求立即中止", async () => {
  const captured: { signal?: AbortSignal } = {};
  const ext = new AbortController();
  ext.abort();
  const client = new MonitorClient("http://127.0.0.1:1", "pw", { fetchImpl: fakeFetch(captured), signal: ext.signal });
  await assert.rejects(client.health(60_000));
  assert.equal(captured.signal?.aborted, true);
});

test("无外部 signal → 行为不变（超时路径仍由内部 controller 掌管）", async () => {
  const captured: { signal?: AbortSignal } = {};
  const client = new MonitorClient("http://127.0.0.1:1", "pw", {
    fetchImpl: fakeFetch(captured),
  });
  await assert.rejects(client.health(10));
  assert.equal(captured.signal?.aborted, true); // 内部超时触发，同一条 abort 链
});
