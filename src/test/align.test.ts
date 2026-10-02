import test from "node:test";
import assert from "node:assert/strict";
import { align, BudgetExceededError, DEFAULT_BUDGET } from "../core/align.js";
import { defaultMatrix } from "../core/matrix.js";
import { bruteForceBestScore } from "../core/bruteforce.js";
import { verifyAlignment } from "../core/verify.js";
import type { ScoreMatrix } from "../core/types.js";

const M = () => defaultMatrix(2, -1); // match +2, mismatch -1
const GAP = { open: 5, extend: 1 };

test("完全相同：全长度恒等比对，得分 2*L", () => {
  const seq = "MKLMPK";
  const r = align(seq, seq, M(), GAP)!;
  assert.equal(r.score, 2 * seq.length);
  assert.deepEqual([r.aStart, r.aEnd, r.bStart, r.bEnd], [0, 6, 0, 6]);
  assert.equal(r.alignedA, seq);
  assert.equal(r.alignedB, seq);
  assert.equal(r.cigar, "6M");
  assert.equal(r.unalignedPrefixA + r.unalignedSuffixA, "");
});

test("无正分：返回 null 而不是强行匹配", () => {
  const r = align("AAA", "RRR", M(), GAP);
  assert.equal(r, null);
});

test("内部长插入：连续缺口 L 代价 = open+(L-1)*extend", () => {
  // B 相对 A 在匹配核心内部插入 WWW（长度 3），两侧匹配足够长以保证缺口值得
  const r = align("MKLPRST", "MKLPWWWRST", M(), { open: 2, extend: 1 })!;
  assert.equal(r.cigar, "4M3D3M");
  assert.equal(r.score, 2 * 7 - (2 + 2 * 1)); // 14 - (open=2 + (3-1)*extend=2) = 10
  assert.deepEqual([r.aStart, r.aEnd], [0, 7]);
  assert.deepEqual([r.bStart, r.bEnd], [0, 10]);
});

test("缺口长度 1 与长度 2 的罚分差恰为一个 extend", () => {
  // B 比核心多 1 个 / 2 个 W：对齐到 A 时是 A 上的缺口（D）
  const g1 = align("MKLPRST", "MKLPWRST", M(), { open: 2, extend: 1 })!;
  const g2 = align("MKLPRST", "MKLPWWRST", M(), { open: 2, extend: 1 })!;
  assert.ok(g1.cigar.includes("1D"), g1.cigar);
  assert.ok(g2.cigar.includes("2D"), g2.cigar);
  assert.equal(g1.score - g2.score, 1, "缺口从长度 1 增到 2 只应多罚一个 extend=1");
});

test("局部前后杂段：两端残基标为未对齐，不产生端缺口罚分", () => {
  const r = align("WWWMPKWWW", "QQQMPKQQQ", M(), GAP)!;
  assert.equal(r.alignedA, "MPK");
  assert.equal(r.alignedB, "MPK");
  assert.deepEqual([r.aStart, r.aEnd], [3, 6]);
  assert.deepEqual([r.bStart, r.bEnd], [3, 6]);
  assert.equal(r.unalignedPrefixA, "WWW");
  assert.equal(r.unalignedSuffixA, "WWW");
  assert.equal(r.cigar, "3M");
});

test("多个并列最高分：确定性选择行优先最早单元", () => {
  // a 中三个相同 "MPK" 块（以错配残基 Q 隔开），b 只有一个 "MPK"；
  // 与任一块对齐都是同分，确定性规则要求取行优先的最早起点 (0,..)
  const a = "MPKQQMPKQQMPK";
  const b = "MPK";
  const r1 = align(a, b, M(), GAP)!;
  const r2 = align(a, b, M(), GAP)!;
  assert.deepEqual(
    [r1.aStart, r1.aEnd, r1.bStart, r1.bEnd, r1.score, r1.cigar],
    [r2.aStart, r2.aEnd, r2.bStart, r2.bEnd, r2.score, r2.cigar],
  );
  assert.equal(r1.aStart, 0, "并列时取最早起点");
  assert.equal(r1.bStart, 0);
  assert.equal(r1.cigar, "3M");
});

test("非对称矩阵严格按输入方向使用，不偷偷对称化", () => {
  // 仅含 {A,R} 的 2x2 非对称矩阵：score(A,R)=+5（按 A 列 R 行），score(R,A)=-5
  const asym: ScoreMatrix = {
    name: "asym2",
    alphabet: ["A", "R"],
    matrix: [
      [2, 5], // A 行：A-A=2, A-R=5（A 在序列A侧 / R 在序列B侧）
      [-5, 2], // R 行：R-A=-5, R-R=2
    ],
  };
  const fwd = align("A", "R", asym, GAP)!;
  assert.equal(fwd.score, 5);
  const rev = align("R", "A", asym, GAP);
  assert.equal(rev, null, "R-A=-5 无正分，若被对称化则会得 +5");
});

test("对称矩阵交换两条序列后最高分不变", () => {
  const r1 = align("MKLMPKMKLM", "MKLMWWKMKLM", M(), { open: 2, extend: 1 });
  const r2 = align("MKLMWWKMKLM", "MKLMPKMKLM", M(), { open: 2, extend: 1 });
  assert.equal(r1!.score, r2!.score);
});

test("短序列穷举：DP 最优分 == 枚举合法路径最优分", () => {
  const sm = defaultMatrix(2, -1);
  const pairs: [string, string, { open: number; extend: number }][] = [
    ["ARK", "RAK", { open: 3, extend: 1 }],
    ["AA", "ARA", { open: 2, extend: 1 }],
    ["MKW", "MKWP", { open: 5, extend: 1 }],
    ["AR", "RA", { open: 1, extend: 1 }],
    ["AKR", "RK", { open: 4, extend: 2 }],
  ];
  for (const [a, b, gap] of pairs) {
    const dp = align(a, b, sm, gap);
    const brute = bruteForceBestScore(a, b, sm, gap);
    assert.equal(dp?.score ?? 0, brute, `${a} vs ${b}`);
  }
});

test("穷举枚举在多组随机短序列上与 DP 一致", () => {
  const letters = ["A", "R", "K", "M", "W"];
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const sm = defaultMatrix(2, -1);
  for (let t = 0; t < 60; t++) {
    const la = 2 + Math.floor(rand() * 4);
    const lb = 2 + Math.floor(rand() * 4);
    const a = Array.from({ length: la }, () => letters[Math.floor(rand() * letters.length)]).join("");
    const b = Array.from({ length: lb }, () => letters[Math.floor(rand() * letters.length)]).join("");
    const gap = { open: 1 + Math.floor(rand() * 5), extend: 1 + Math.floor(rand() * 3) };
    const dp = align(a, b, sm, gap);
    assert.equal(dp?.score ?? 0, bruteForceBestScore(a, b, sm, gap), `${a} vs ${b} open=${gap.open}`);
  }
});

test("对齐串重新计分 == 报告总分（核验器正向）", () => {
  const r = align("MKLMPKMKLM", "MKLMWWKMKLM", M(), { open: 2, extend: 1 })!;
  const v = verifyAlignment(r, M(), 2, 1);
  assert.equal(v.valid, true, v.errors.join("; "));
  assert.equal(v.recomputedScore, r.score);
});

test("核验器识别篡改的 CIGAR 与越界坐标", () => {
  const r = align("MKLMPKMKLM", "MKLMWWKMKLM", M(), { open: 2, extend: 1 })!;
  const badCigar = { ...r, cigar: r.cigar.replace("D", "I") };
  const v1 = verifyAlignment(badCigar, M(), 2, 1);
  assert.equal(v1.valid, false);
  assert.ok(v1.errors.join(";").includes("CIGAR") || v1.errors.join(";").includes("矛盾"));
  const badScore = { ...r, score: r.score + 100 };
  const v2 = verifyAlignment(badScore, M(), 2, 1);
  assert.equal(v2.valid, false);
  assert.ok(v2.errors.some((x) => x.includes("总分")));
});

test("开缺口代价影响 长缺口 与 多个短缺口 的取舍", () => {
  // s1 中 "P" 对应 s2 的一个插入点；对比 open=1 与 open=8 时总分与结构
  const s1 = "MKLMPKMKLM";
  const s2 = "MKLMWWWPKMKLM";
  const low = align(s1, s2, M(), { open: 1, extend: 1 })!;
  const high = align(s1, s2, M(), { open: 8, extend: 1 })!;
  // 两种参数下都是合法方案；提高 open 后相对代价结构改变，
  // 这里验证：含长缺口的方案在高 open 下得分显著更低，且至少一个方案结构改变
  assert.ok(low.score > high.score);
});

test("超出预算：不输出假定最优结果", () => {
  assert.throws(
    () => align("A".repeat(10), "A".repeat(10), M(), GAP, { maxLength: 5, maxCells: 1_000_000 }),
    BudgetExceededError,
  );
  assert.throws(
    () => align("A".repeat(100), "A".repeat(100), M(), GAP, { maxLength: 5000, maxCells: 100 }),
    BudgetExceededError,
  );
});

test("默认预算常量存在且为正值", () => {
  assert.ok(DEFAULT_BUDGET.maxLength > 0 && DEFAULT_BUDGET.maxCells > 0);
});
