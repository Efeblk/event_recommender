import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { CHECKPOINT_SAVE_TIMEOUT_MS } from "../../collector/publish.mjs";

void test("collector waits for the bounded server publication result within the Cloud Run limit", async () => {
  const route = await readFile(resolve(import.meta.dirname, "../app/api/admin/collection/route.ts"), "utf8");
  const match = route.match(/const PUBLICATION_DEADLINE_MS = ([0-9_]+);/);
  assert.ok(match, "Publication route must declare its server deadline.");
  const serverDeadline = Number(match[1].replaceAll("_", ""));
  assert.equal(serverDeadline, 260_000);
  assert.ok(CHECKPOINT_SAVE_TIMEOUT_MS >= serverDeadline + 20_000);
  assert.ok(CHECKPOINT_SAVE_TIMEOUT_MS < 300_000);
});
