import { ScoreParams } from "../src/types.js";
import { substScore } from "../src/scoring.js";

/**
 * 独立于主引擎的“暴力”核验器（仅供短序列测试）。
 * 以 (i,j,状态,当前缺口方向) 为状态递归枚举所有合法的局部比对路径：
 *   - 任意位置可自由开始（局部比对），任意位置可自由结束；
 *   - M 同时消费两条；I 只消费 A；D 只消费 B；
     *   - 连续 I/D 归并为一个缺口，首列扣 open（首列代价 open），后续每列只扣 extend；
     *     长度 L 合计 open+(L-1)*extend。
 * 递归直接累加缺口代价，不使用主引擎的三状态公式。
 */
export function bruteForceBestScore(A: string, B: string, p: ScoreParams): number {
  const m = A.length;
  const n = B.length;
  const memo = new Map<string, number>();

  // gap: 0=无缺口(M之间), 1=正在I, 2=正在D
  function go(i: number, j: number, gap: 0 | 1 | 2): number {
    let best = 0; // 随时可结束
    const key = `${i},${j},${gap}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    if (i < m && j < n) {
      best = Math.max(best, substScore(p, A[i], B[j]) + go(i + 1, j + 1, 0));
    }
    if (i < m) {
      const cost = gap === 1 ? p.gapExtend : p.gapOpen + p.gapExtend;
      best = Math.max(best, -cost + go(i + 1, j, 1));
    }
    if (j < n) {
      const cost = gap === 2 ? p.gapExtend : p.gapOpen + p.gapExtend;
      best = Math.max(best, -cost + go(i, j + 1, 2));
    }
    memo.set(key, best);
    return best;
  }

  // 显式枚举所有自由起点（go 内部的 0 已允许任意结束，起点在外部遍历）
  let globalBest = 0;
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      globalBest = Math.max(globalBest, go(i, j, 0));
    }
  }
  return globalBest;
}

/** 测试用：直接按对齐列重算分数（与生产核验器同概念的独立实现）。 */
export function rescore(alignedA: string, alignedB: string, p: ScoreParams): number {
  let score = 0;
  for (let k = 0; k < alignedA.length; k++) {
    if (alignedA[k] !== "-" && alignedB[k] !== "-") {
      score += substScore(p, alignedA[k], alignedB[k]);
    }
  }
  const ops = alignedA.split("").map((x, i) => (x === "-" ? "D" : alignedB[i] === "-" ? "I" : "M")).join("");
  for (let k = 0; k < ops.length; ) {
    const op = ops[k];
    if (op === "M") { k++; continue; }
    let L = 0;
    while (ops[k] === op) { L++; k++; }
    score -= p.gapOpen + (L - 1) * p.gapExtend;
  }
  return score;
}
