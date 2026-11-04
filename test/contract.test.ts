// 契约测试：spec 快照逐字段对照 §1.2.1 synthetic 端点契约（M0，PLAN §1.3-4）
// 快照由 scripts/fetch-spec.ts 抓取；若 opencode 版本升级，重抓后此测试即守门人

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const fixturesDir = path.join(import.meta.dirname, "fixtures");
const snapshots = readdirSync(fixturesDir)
  .filter((f) => /^openapi-.*\.json$/.test(f))
  .map((f) => ({
    version: f.replace(/^openapi-(.*)\.json$/, "$1"),
    spec: JSON.parse(readFileSync(path.join(fixturesDir, f), "utf8")),
  }));

assert.ok(snapshots.length > 0, "no openapi snapshot in test/fixtures — run scripts/fetch-spec.ts");

type Operation = {
  operationId?: string;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, unknown>;
};

function resolveRef(spec: Record<string, unknown>, node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/")) {
    let cur: unknown = spec;
    for (const seg of obj.$ref.slice(2).split("/")) {
      cur = (cur as Record<string, unknown>)?.[seg];
    }
    return resolveRef(spec, cur);
  }
  return obj;
}

/** 递归收集节点下所有 string enum（穿透 $ref / anyOf / oneOf / allOf） */
function collectEnums(spec: Record<string, unknown>, node: unknown, depth = 0, seen = new Set<unknown>()): string[][] {
  if (node === null || typeof node !== "object" || depth > 8 || seen.has(node)) return [];
  seen.add(node);
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") return collectEnums(spec, resolveRef(spec, obj), depth + 1, seen);
  const out: string[][] = [];
  if (Array.isArray(obj.enum)) out.push(obj.enum as string[]);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[key])) {
      for (const sub of obj[key]) out.push(...collectEnums(spec, sub, depth + 1, seen));
    }
  }
  return out;
}

for (const { version, spec } of snapshots) {
  test(`[${version}] synthetic endpoint is registered with operationId`, () => {
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    const op = paths["/api/session/{sessionID}/synthetic"]?.post;
    assert.ok(op, "POST /api/session/{sessionID}/synthetic missing");
    assert.equal(op.operationId, "session.synthetic");
  });

  test(`[${version}] synthetic payload: text is the only required field`, () => {
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    const op = paths["/api/session/{sessionID}/synthetic"]!.post!;
    const schema = resolveRef(spec, op.requestBody?.content?.["application/json"]?.schema) as {
      required?: string[];
      properties?: Record<string, { type?: string; enum?: string[]; nullable?: boolean }>;
    };
    assert.deepEqual(schema.required, ["text"], "text must be the sole required field");
    const props = schema.properties ?? {};
    for (const field of ["id", "description", "metadata", "delivery", "resume"]) {
      assert.ok(props[field], `payload field ${field} missing`);
    }
  });

  test(`[${version}] delivery enum is exactly steer|queue`, () => {
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    const op = paths["/api/session/{sessionID}/synthetic"]!.post!;
    const schema = resolveRef(spec, op.requestBody?.content?.["application/json"]?.schema) as {
      properties?: Record<string, unknown>;
    };
    // delivery 经 anyOf[$ref Session.Inbox.Delivery, null] 间接引用，递归收集 enum
    const enums = collectEnums(spec, schema.properties?.["delivery"]);
    assert.ok(
      enums.some((e) => [...e].sort().join(",") === "queue,steer"),
      `delivery enum mismatch: ${JSON.stringify(enums)}`,
    );
  });

  test(`[${version}] synthetic error responses: 400/401/404/409 declared`, () => {
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    const op = paths["/api/session/{sessionID}/synthetic"]!.post!;
    for (const code of ["400", "401", "404", "409"]) {
      assert.ok(op.responses?.[code], `response ${code} not declared`);
    }
  });

  test(`[${version}] companion endpoints registered (inbox/session/info/prompt)`, () => {
    const paths = spec.paths as Record<string, Record<string, Operation>>;
    assert.ok(paths["/api/session/{sessionID}/inbox"]?.get, "GET inbox missing");
    assert.ok(paths["/api/session/{sessionID}"]?.get, "GET session (存活校验) missing");
    assert.ok(paths["/api/info"]?.get, "GET /api/info missing");
    assert.ok(paths["/api/session/{sessionID}/prompt"]?.post, "POST prompt (降级通道) missing");
  });
}
