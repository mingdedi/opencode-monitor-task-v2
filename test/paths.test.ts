import assert from "node:assert/strict";
import { test } from "node:test";
import { dataDir, serviceFilePath, stateDir, taskDir, tasksDir } from "../packages/shared/src/paths.ts";

test("XDG overrides respected", () => {
  const env = { XDG_STATE_HOME: "/tmp/omt-test-state", XDG_DATA_HOME: "/tmp/omt-test-data" };
  assert.equal(stateDir(env), "/tmp/omt-test-state/opencode-monitor-task");
  assert.equal(dataDir(env), "/tmp/omt-test-data/opencode-monitor-task");
});

test("falls back to HOME/.local/{state,data}", () => {
  const env = { HOME: "/home/tester" };
  assert.equal(stateDir(env), "/home/tester/.local/state/opencode-monitor-task");
  assert.equal(dataDir(env), "/home/tester/.local/share/opencode-monitor-task");
  assert.equal(serviceFilePath(env), "/home/tester/.local/state/opencode-monitor-task/service.json");
});

test("task paths compose under tasks/", () => {
  const env = { XDG_DATA_HOME: "/tmp/omt-data" };
  assert.equal(tasksDir(env), "/tmp/omt-data/opencode-monitor-task/tasks");
  assert.equal(taskDir(env, "mon_abc"), "/tmp/omt-data/opencode-monitor-task/tasks/mon_abc");
});

test("relative XDG override rejected (must be absolute)", () => {
  const env = { HOME: "/home/tester", XDG_STATE_HOME: "rel/path" };
  // 相对覆盖回退到 HOME 而非抛错
  assert.equal(stateDir(env), "/home/tester/.local/state/opencode-monitor-task");
});

test("no HOME and no override throws", () => {
  assert.throws(() => stateDir({}));
});
