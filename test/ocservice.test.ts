import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { opencodeAuthHeader, opencodeServicePath, readOpencodeService } from "../packages/shared/src/ocservice.ts";

const base = mkdtempSync(path.join(tmpdir(), "omt-ocservice-"));
after(() => rmSync(base, { recursive: true, force: true }));

function writeService(dir: string, content: string) {
  const ocDir = path.join(dir, "opencode");
  mkdirSync(ocDir, { recursive: true });
  writeFileSync(path.join(ocDir, "service.json"), content);
}

test("reads service.json via XDG_STATE_HOME override", () => {
  const dir = path.join(base, "ok");
  writeService(dir, JSON.stringify({ url: "http://127.0.0.1:41000", password: "pw-test", pid: 1 }));
  const env = { XDG_STATE_HOME: dir };
  assert.equal(opencodeServicePath(env), path.join(dir, "opencode", "service.json"));
  const svc = readOpencodeService(env);
  assert.equal(svc.url, "http://127.0.0.1:41000");
  assert.equal(svc.password, "pw-test");
});

test("falls back to HOME when no XDG_STATE_HOME", () => {
  const dir = path.join(base, "home");
  writeService(path.join(dir, ".local", "state"), JSON.stringify({ url: "http://127.0.0.1:41001", password: "x" }));
  const svc = readOpencodeService({ HOME: dir });
  assert.equal(svc.url, "http://127.0.0.1:41001");
});

test("auth header is Basic base64(opencode:<password>)", () => {
  const header = opencodeAuthHeader({ url: "http://x", password: "s3cret" });
  assert.equal(header, "Basic " + Buffer.from("opencode:s3cret").toString("base64"));
});

test("malformed service.json (missing url/password) throws", () => {
  const dir = path.join(base, "bad");
  writeService(dir, JSON.stringify({ url: "http://127.0.0.1:41002" }));
  assert.throws(() => readOpencodeService({ XDG_STATE_HOME: dir }), /url\/password missing/);
});

test("missing service.json throws ENOENT", () => {
  const dir = path.join(base, "empty");
  mkdirSync(path.join(dir, "opencode"), { recursive: true });
  assert.throws(() => readOpencodeService({ XDG_STATE_HOME: dir }), /ENOENT/);
});
