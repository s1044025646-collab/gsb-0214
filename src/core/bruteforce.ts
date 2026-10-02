import type { GapParams, ScoreMatrix } from "./types.js";
import { MatrixLookup } from "./matrix.js";

/**
 * 仅供测试的短序列穷举器：枚举所有合法局部比对路径
 * （起点任意、首列必须匹配、末列必须匹配、单调走格），
 * 用与生产代码相同的 run 缺口代价定义直接累加，返回真正最高分。
 * 仅适用于极短序列（建议长度 <= 7）。
 */
export function bruteForceBestScore(
  seqA: string,
  seqB: string,
  sm: ScoreMatrix,
  gap: GapParams,
): number {
  const lookup = new MatrixLookup(sm);
  const { open: o, extend: e } = gap;
  let best = 0;

  // gapState: 0 无上一列缺口；1 上一列是 I（消费 A）；2 上一列是 D（消费 B）
  const dfs = (i: number, j: number, gapState: number, score: number, started: boolean) => {
    if (score > best) best = score;
    // M：匹配列
    if (i < seqA.length && j < seqB.length) {
      const s = lookup.score(seqA[i] as string, seqB[j] as string);
      dfs(i + 1, j + 1, 0, score + s, true);
    }
    if (!started) return;
    // I：消费 A（B 上缺口）
    if (i < seqA.length) {
      const cost = gapState === 1 ? e : o;
      dfs(i + 1, j, 1, score - cost, started);
    }
    // D：消费 B（A 上缺口）
    if (j < seqB.length) {
      const cost = gapState === 2 ? e : o;
      dfs(i, j + 1, 2, score - cost, started);
    }
  };

  for (let a0 = 0; a0 < seqA.length; a0++) {
    for (let b0 = 0; b0 < seqB.length; b0++) {
      const s = lookup.score(seqA[a0] as string, seqB[b0] as string);
      // 首列必须为匹配列；若首分已为负则跳过（局部比对从正收益处开始）
      dfs(a0 + 1, b0 + 1, 0, s, true);
    }
  }
  return Math.max(best, 0);
}
