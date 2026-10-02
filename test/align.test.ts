import { test } from "node:test";
import assert from "node:assert/strict";
import { align } from "../src/align.js";
import { verifyAlignment } from "../src/verify.js";
import { defaultParams } from "../src/scoring.js";
import { bruteForceBestScore, rescore } from "./support.js";

const P = (o: Partial<Parameters<typeof defaultParams>[0]> = {}) => defaultParams(o);

test("完全相同序列：满分逐列匹配", () => {
  const r = align("ACDE", "ACDE", P());
  assert.equal(r.status, "ok");
  assert.equal(r.positive, true);
  assert.equal(r.score, 8);
  assert.equal(r.alignment!.alignedA, "ACDE");
  assert.equal(r.alignment!.alignedB, "ACDE");
  assert.equal(r.alignment!.cigar, "4M");
  assert.equal(r.alignment!.coords.a[0], 0);
  assert.equal(r.alignment!.coords.a[1], 4);
  assert.equal(verifyAlignment("ACDE", "ACDE", r.alignment!, r.paramsSnapshot, r.score).valid, true);
});

test("无正分：全错配且错配分为负时返回没有正分比对", () => {
  const r = align("AAAA", "VVVV", P());
  assert.equal(r.positive, false);
  assert.equal(r.score, 0);
  assert.equal(r.alignment, undefined);
});

test("空序列与非法字符给出明确错误结果", () => {
  const empty = align("", "AC", P());
  assert.equal(empty.status, "invalid_input");
  assert.match(empty.errors!.join(" "), /为空序列/);
  const bad = align("ACX", "AC", P());
  assert.equal(bad.status, "invalid_input");
  assert.match(bad.errors!.join(" "), /非法字符 'X'/);
});

test("内部长插入：缺口长度1与长度2罚分 = open 与 open+extend", () => {
  // A: ACDE  B: AE  -> 期望 A 中间 CD 形成长度2缺口（D 操作：B 缺）
  const r = align("ACDE", "AE", P({ gapOpen: 2, gapExtend: 1 }));
  assert.ok(r.alignment);
  assert.equal(r.alignment!.alignedA, "ACDE");
  assert.equal(r.alignment!.alignedB, "A--E");
  assert.equal(r.alignment!.cigar, "1M2D1M");
  const bd = r.alignment!.breakdown;
  assert.equal(bd.gapOpenCount, 1);
  assert.equal(bd.gapExtendCount, 1); // 长度2 = 1次开放 + 1次延长
  assert.equal(bd.gapPenalty, 3);     // 2 + 1
  assert.equal(r.score, 4 - 3);
});

test("缺口长度1仅收 open+extend，不再有延长分量", () => {
  const r = align("ACD", "AD", P({ gapOpen: 1, gapExtend: 1 }));
  assert.equal(r.alignment!.alignedA, "ACD");
  assert.equal(r.alignment!.alignedB, "A-D");
  assert.equal(r.alignment!.breakdown.gapPenalty, 2);
  assert.equal(r.alignment!.breakdown.gapExtendCount, 0);
});

test("局部前后杂段：只取正分核心，两端残基标记为未对齐且不罚内部缺口", () => {
  const r = align("XXKKKKKKYY", "WWKKKKKKZZ", P());
  assert.equal(r.alignment!.alignedA, "ACDE");
  assert.equal(r.alignment!.alignedB, "ACDE");
  assert.deepEqual(r.alignment!.coords.a, [2, 6]);
  assert.deepEqual(r.alignment!.coords.b, [2, 6]);
  assert.equal(r.alignment!.unaligned.aPrefix, "XX");
  assert.equal(r.alignment!.unaligned.aSuffix, "YY");
  assert.equal(r.alignment!.unaligned.bPrefix, "WW");
  assert.equal(r.alignment!.unaligned.bSuffix, "ZZ");
  assert.equal(r.score, 8);
});

test("多个并列最高分：确定性返回唯一结果且可复现", () => {
  const r1 = align("MKGH", "MKGH", P());
  const r2 = align("MKGH", "MKGH", P());
  assert.deepEqual(r1.alignment, r2.alignment);
});

test("对齐串重新计分等于总分（外部核验器）", () => {
  const r = align("GHIKLAC", "ACGHIKL", P());
  assert.ok(r.alignment);
  const v = verifyAlignment("GHIKLAC", "ACGHIKL", r.alignment!, r.paramsSnapshot, r.score);
  assert.equal(v.valid, true, v.problems.join("; "));
  assert.equal(v.recomputedScore, r.score);
  assert.equal(rescore(r.alignment!.alignedA, r.alignment!.alignedB, r.paramsSnapshot), r.score);
});

test("短序列：对大量随机短序列，主引擎最优分与独立枚举一致", () => {
  const AAs = "ARNDCQEGHILKMFPSTWYV";
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let t = 0; t < 300; t++) {
    const m = 1 + Math.floor(rnd() * 5);
    const n = 1 + Math.floor(rnd() * 5);
    const A = Array.from({ length: m }, () => AAs[Math.floor(rnd() * 20)]).join("");
    const B = Array.from({ length: n }, () => AAs[Math.floor(rnd() * 20)]).join("");
    for (const params of [P(), P({ gapOpen: 2, gapExtend: 1 }), P({ match: 1, mismatch: -2, gapOpen: 3, gapExtend: 2 })]) {
      const r = align(A, B, params);
      const brute = bruteForceBestScore(A, B, params);
      assert.equal(r.score, brute, `A=${A} B=${B} engine=${r.score} brute=${brute}`);
      if (r.alignment) {
        assert.equal(rescore(r.alignment.alignedA, r.alignment.alignedB, params), r.score);
      }
    }
  }
});

test("对称矩阵交换两条序列后最优分不变", () => {
  const A = "GHIKLM";
  const B = "GHLKLM";
  const r1 = align(A, B, P());
  const r2 = align(B, A, P());
  assert.equal(r1.score, r2.score);
});

test("非对称矩阵严格按方向使用，不被对称化", () => {
  // 构造非对称矩阵：[A][R]=5，[R][A]=-5，对角=2，其余=-3
  const AAs = "ARNDCQEGHILKMFPSTWYV".split("");
  const rows: number[][] = AAs.map((x) => AAs.map((y) => (x === y ? 2 : -3)));
  const idx = (c: string) => AAs.indexOf(c);
  rows[idx("A")][idx("R")] = 5;
  rows[idx("R")][idx("A")] = -5;
  const params: any = P();
  params.matrix = {};
  for (const x of AAs) { params.matrix[x] = {}; for (const y of AAs) params.matrix[x][y] = rows[idx(x)][idx(y)]; }

  const forward = align("A", "R", params);
  const reverse = align("R", "A", params);
  assert.equal(forward.score, 5);
  assert.equal(reverse.positive, false); // -5 不产生正分
});

test("预算超限拒绝输出假定最优", () => {
  const long = "A".repeat(2001);
  const r = align(long, "AA", P());
  assert.equal(r.status, "rejected_budget");
});
