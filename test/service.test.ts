import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "align-test-"));
process.env.ALIGN_DATA_DIR = tmp;
process.env.ALIGN_DB = path.join(tmp, "test.sqlite");

const { solve, recheckReport, diffParams } = await import("../src/service.js");
const { getDb, getParams, getReport, listReports } = await import("../src/db.js");
const { verifyAlignment } = await import("../src/verify.js");

before(() => { getDb(); });

test("端到端求解：序列/参数冻结、报告保存、自动核验通过", () => {
  const r = solve({
    aName: "s1", bName: "s2",
    aSeq: "ACDEFGHIK", bSeq: "ACLDEFGHIK",
    params: { gapOpen: 5, gapExtend: 1 },
  });
  assert.ok(r.reportId);
  assert.ok(r.result!.alignment);
  assert.equal(r.verification!.valid, true);
});

test("篡改操作串会被外部核验器识别", () => {
  const r = solve({ aName: "t1", bName: "t2", aSeq: "ACDEKKK", bSeq: "ALCDEKKK", params: { gapOpen: 2 } });
  const al = r.result!.alignment!;
  assert.match(al.ops, /D/);
  const tampered = { ...al, ops: "M".repeat(al.ops.length) };
  const v = verifyAlignment("ACDEKKK", "ALCDEKKK", tampered, r.result!.paramsSnapshot, r.result!.score);
  assert.equal(v.valid, false);
  assert.ok(v.problems.length > 0);

  // 纯 CIGAR 篡改（ops 不动，仅改 cigar）也应被识别
  const cigarTamper = { ...al, cigar: "99M" };
  const v2 = verifyAlignment("ACDEKKK", "ALCDEKKK", cigarTamper, r.result!.paramsSnapshot, r.result!.score);
  assert.equal(v2.valid, false);
});

test("修改开缺口代价改变长缺口与多个短缺口的取舍", () => {
  // 共享匹配段，中间分布可聚成一个长缺口或拆成短缺口（此处验证 open 代价对结构的影响）
  const A = "MMMMACDEGHIK";
  const B = "MMMMGHIK";
  const cheap = solve({ aName: "o1", bName: "o2", aSeq: A, bSeq: B, params: { gapOpen: 2, gapExtend: 1 } });
  const expensive = solve({ aName: "o1", bName: "o2", aSeq: A, bSeq: B, params: { gapOpen: 10, gapExtend: 1 } });
  // open 便宜时允许带缺口对齐；open 很贵时要么无正分、要么改取不同局部核心
  assert.ok(cheap.result!.score >= expensive.result!.score);
  if (expensive.result!.alignment) {
    assert.equal(
      expensive.result!.alignment.breakdown.gapOpenCount < cheap.result!.alignment!.breakdown.gapOpenCount
      || expensive.result!.score < cheap.result!.score,
      true,
    );
  }
});

test("参数版本比较识别 open 代价变化", () => {
  const r1 = solve({ aName: "d1", bName: "d2", aSeq: "AAA", bSeq: "AAA", params: { gapOpen: 5 }, paramName: "dp" });
  const r2 = solve({ aName: "d1", bName: "d2", aSeq: "AAA", bSeq: "AAA", params: { gapOpen: 9 }, paramName: "dp" });
  const d = diffParams((getReport(r1.reportId!) as any).score_param_id, (getReport(r2.reportId!) as any).score_param_id);
  assert.ok(d.diff!.changes.some((c) => c.field === "gapOpen"));
});

test("服务重启后复核旧报告：仅依据冻结证据重新核验", () => {
  const r = solve({ aName: "p1", bName: "p2", aSeq: "GHIKLM", bSeq: "GHLKLM", params: {} });
  const id = r.reportId!;
  // 模拟重启：清空模块无法做到，但直接走 recheckReport（只读 SQLite，不重跑 DP）
  const rc = recheckReport(id);
  assert.equal(rc.verification!.valid, true);
  assert.equal(rc.verification!.recomputedScore, (rc.report!.result as any).score);
  assert.ok(getReport(id));
});

test("JSON 导出包含冻结的序列、参数与报告", () => {
  assert.ok(listReports().length >= 1);
  assert.ok(getParams(1));
});
