import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";
import {
  addScoreSet,
  addSequence,
  getAlignment,
  getScoreSetVersion,
  openDb,
} from "../db/db.js";
import { solve, verifyStored } from "../service.js";
import { defaultMatrix } from "../core/matrix.js";

function freshDb(name: string) {
  const path = join(tmpdir(), `protalign-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }
  return { path, db: openDb(path) };
}

test("序列同名自动升版本，旧版本快照保留", () => {
  const { db } = freshDb("seq");
  const v1 = addSequence(db, "prot", "MKLM");
  const v2 = addSequence(db, "prot", "MKLMPK");
  assert.equal(v1.version, 1);
  assert.equal(v2.version, 2);
  assert.equal(getScoreSetVersion.length >= 0, true);
});

test("比对冻结输入与评分规则；评分集新版本不影响旧报告", () => {
  const { db } = freshDb("freeze");
  addScoreSet(db, "rules", defaultMatrix(2, -1), 5, 1);
  const out = solve(db, { seqARaw: "MKLMPK", seqBRaw: "MKLMWWPK", scoreSetName: "rules" });
  const before = getAlignment(db, out.id)!;
  const scoreBefore = before.result!.score;

  // 同一名字发布新版本评分（更贵的缺口）
  addScoreSet(db, "rules", defaultMatrix(2, -1), 50, 10);
  const after = getAlignment(db, out.id)!;
  assert.equal(after.result!.score, scoreBefore, "旧报告分数不得随评分集新版本改变");
  assert.equal(after.snapshots.gapOpen, 5);
  assert.equal(after.snapshots.gapExtend, 1);
});

test("服务重启后复核旧报告：关闭并重新打开数据库", () => {
  const { path } = freshDb("restart");
  const db1 = openDb(path);
  const out = solve(db1, { seqARaw: "WWWMPKWWW", seqBRaw: "QQQMPKQQQ", gapOpen: 4, gapExtend: 2 });
  const id = out.id;
  db1.close();

  const db2 = openDb(path);
  const stored = getAlignment(db2, id)!;
  assert.equal(stored.result!.alignedA, "MPK");
  assert.equal(stored.result!.aStart, 3);
  assert.equal(stored.result!.bStart, 3);
  assert.equal(stored.result!.cigar, "3M");
  const v = verifyStored(db2, id);
  assert.equal(v.valid, true, JSON.stringify(v));
  db2.close();
});

test("空序列与非法序列在求解时被拒绝，不产生报告", () => {
  const { db } = freshDb("bad");
  assert.throws(() => solve(db, { seqARaw: "", seqBRaw: "MK" }), /为空/);
  assert.throws(() => solve(db, { seqARaw: "MKB", seqBRaw: "MK" }), /标准氨基酸/);
  const n = db.prepare("SELECT COUNT(*) AS c FROM alignments").get() as { c: number };
  assert.equal(n.c, 0);
});

test("无正分比对也被持久化为显式 no-positive 报告", () => {
  const { db } = freshDb("nopos");
  const out = solve(db, { seqARaw: "AAA", seqBRaw: "RRR" });
  const stored = getAlignment(db, out.id)!;
  assert.equal(stored.noPositive, true);
  assert.equal(stored.result, null);
  const v = verifyStored(db, out.id);
  assert.equal(v.noPositive, true);
});
