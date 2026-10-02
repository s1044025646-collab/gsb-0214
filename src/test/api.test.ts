import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";

const DB = join(tmpdir(), `protalign-api-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
const PORT = 41000 + Math.floor(Math.random() * 4000);

test.before(async () => {
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, DATA_DIR: tmpdir() },
    stdio: "ignore",
  });
  (globalThis as Record<string, unknown>).__apiChild = child;
  const base = `http://localhost:${PORT}`;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("API 服务未在超时内启动");
});

test.after(() => {
  const child = (globalThis as Record<string, unknown>).__apiChild as ReturnType<typeof spawn>;
  child.kill();
  // 临时文件尽力清理；Windows 下 WAL 句柄可能延迟释放，忽略失败
  setTimeout(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(DB + suffix, { force: true }); } catch { /* ignore */ }
    }
  }, 200).unref();
});

const base = () => `http://localhost:${PORT}`;

test("健康检查 + 完整求解/核验/比较/导出流程", async () => {
  const h = await (await fetch(base() + "/api/health")).json();
  assert.equal(h.ok, true);

  const bad = await fetch(base() + "/api/alignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seqARaw: "AAB", seqBRaw: "AA" }),
  });
  assert.equal(bad.status, 400);
  assert.ok(JSON.stringify(await bad.json()).includes("标准氨基酸"));

  const res = await fetch(base() + "/api/alignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seqARaw: "MKLPRST", seqBRaw: "MKLPWWWRST", gapOpen: 2, gapExtend: 1 }),
  });
  assert.equal(res.status, 201);
  const r = (await res.json()) as { id: number; result: { cigar: string; score: number } };
  assert.equal(r.result.cigar, "4M3D3M");
  assert.equal(r.result.score, 10);

  const v = await (await fetch(base() + `/api/alignments/${r.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  })).json();
  assert.equal(v.valid, true);

  const tampered = await (await fetch(base() + `/api/alignments/${r.id}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tamperedCigar: "4M3I3M" }),
  })).json();
  assert.equal(tampered.valid, false);

  const r2 = await (await fetch(base() + "/api/alignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seqARaw: "MKLPRST", seqBRaw: "MKLPWWWRST", gapOpen: 8, gapExtend: 1 }),
  })).json();
  const cmp = await (await fetch(base() + "/api/alignments/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id1: r.id, id2: r2.id }),
  })).json();
  assert.equal(cmp.sameInput, true);
  assert.equal(cmp.sameRules, false);

  const exported = await (await fetch(base() + "/api/export")).json();
  assert.ok(Array.isArray(exported.alignments) && exported.alignments.length >= 2);

  const noPos = await (await fetch(base() + "/api/alignments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seqARaw: "AAA", seqBRaw: "RRR" }),
  })).json();
  assert.equal(noPos.noPositive, true);

  void once;
});
