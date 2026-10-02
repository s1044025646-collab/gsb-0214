import {
  type AlignmentBudget,
  type AlignmentResult,
  type GapParams,
  type ScoreMatrix,
} from "./types.js";
import { MatrixLookup } from "./matrix.js";

export const DEFAULT_BUDGET: AlignmentBudget = { maxLength: 5000, maxCells: 10_000_000 };

const NEG = -1_000_000_000;

// H（匹配列）回溯指针
const P_STOP = 0;
const P_H_FROM_H = 1;
const P_H_FROM_X = 2;
const P_H_FROM_Y = 3;
// X（消费 A，即 B 上缺口）：-o-e 新开 / -e 延长
const P_X_FROM_H_OPEN = 4;
const P_X_FROM_X_EXT = 5;
const P_X_FROM_Y_OPEN = 6;
// Y（消费 B，即 A 上缺口）
const P_Y_FROM_H_OPEN = 7;
const P_Y_FROM_X_OPEN = 8;
const P_Y_FROM_Y_EXT = 9;

export class BudgetExceededError extends Error {
  constructor(
    public readonly lengthA: number,
    public readonly lengthB: number,
    public readonly cells: number,
    public readonly budget: AlignmentBudget,
  ) {
    super(
      `超出公开预算：长度 ${lengthA} x ${lengthB}，单元数 ${cells}；` +
      `限制 maxLength=${budget.maxLength}, maxCells=${budget.maxCells}`,
    );
    this.name = "BudgetExceededError";
  }
}

function pick3(
  v1: number, p1: number,
  v2: number, p2: number,
  v3: number, p3: number,
): { v: number; p: number } {
  // 并列时按候选顺序确定性选择（第一个即最高优先级）
  if (v1 >= v2 && v1 >= v3) return { v: v1, p: p1 };
  if (v2 >= v3) return { v: v2, p: p2 };
  return { v: v3, p: p3 };
}

/**
 * Smith–Waterman 局部比对 + Gotoh 仿射缺口。
 * 长度为 L 的连续缺口代价 = open + (L-1)*extend（两成本均为正）。
 * X[i][j]：以消费 A[i-1] 的缺口列结尾（B 上有缺口）。
 * Y[i][j]：以消费 B[j-1] 的缺口列结尾（A 上有缺口）。
 * H[i][j]：以匹配/错配列结尾，且与局部比对一致地下界截断为 0。
 */
export function align(
  seqA: string,
  seqB: string,
  sm: ScoreMatrix,
  gap: GapParams,
  budget: AlignmentBudget = DEFAULT_BUDGET,
): AlignmentResult | null {
  const m = seqA.length;
  const n = seqB.length;
  if (m === 0 || n === 0) {
    throw new Error("空序列不能进行比对：请先通过序列校验");
  }
  if (m > budget.maxLength || n > budget.maxLength) {
    throw new BudgetExceededError(m, n, (m + 1) * (n + 1), budget);
  }
  const cells = (m + 1) * (n + 1);
  if (cells > budget.maxCells) {
    throw new BudgetExceededError(m, n, cells, budget);
  }

  const lookup = new MatrixLookup(sm);
  const { open: o, extend: e } = gap;
  const W = n + 1;

  const H = new Int32Array(cells);
  const X = new Int32Array(cells).fill(NEG);
  const Y = new Int32Array(cells).fill(NEG);
  const pH = new Int8Array(cells); // 默认 P_STOP
  const pX = new Int8Array(cells);
  const pY = new Int8Array(cells);

  const idx = (i: number, j: number): number => i * W + j;

  let best = 0;
  let bestI = 0;
  let bestJ = 0; // 全零则保持 (0,0)，返回 null

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = idx(i, j);
      const up = idx(i - 1, j);
      const left = idx(i, j - 1);
      const diag = idx(i - 1, j - 1);

      // X：消费 A[i-1]（B 上缺口）
      const xc = pick3(
        H[up] - o, P_X_FROM_H_OPEN,
        X[up] - e, P_X_FROM_X_EXT,
        Y[up] - o, P_X_FROM_Y_OPEN,
      );
      X[c] = xc.v;
      pX[c] = xc.p;

      // Y：消费 B[j-1]（A 上缺口）
      const yc = pick3(
        H[left] - o, P_Y_FROM_H_OPEN,
        X[left] - o, P_Y_FROM_X_OPEN,
        Y[left] - e, P_Y_FROM_Y_EXT,
      );
      Y[c] = yc.v;
      pY[c] = yc.p;

      // H：匹配/错配列，局部比对下界为 0
      const s = lookup.score(seqA[i - 1] as string, seqB[j - 1] as string);
      const hd = pick3(
        H[diag] + s, P_H_FROM_H,
        X[diag] + s, P_H_FROM_X,
        Y[diag] + s, P_H_FROM_Y,
      );
      if (hd.v > 0) {
        H[c] = hd.v;
        pH[c] = hd.p;
      } else {
        H[c] = 0;
        pH[c] = P_STOP;
      }

      // 全局最优：行优先扫描，仅严格大于才更新 => 并列时取最早单元（公开确定性规则）
      if (H[c] > best) {
        best = H[c];
        bestI = i;
        bestJ = j;
      }
    }
  }

  if (best <= 0) {
    // 最高分为 0：不存在正分比对，明确返回 null，绝不强行输出
    return null;
  }

  // ---- 回溯 ----
  interface Col { op: "M" | "X" | "Y"; ca: string; cb: string }
  const cols: Col[] = [];
  let i = bestI;
  let j = bestJ;
  // state: 1=H, 2=X, 3=Y
  let state = 1;
  for (;;) {
    const c = idx(i, j);
    if (state === 1) {
      const p = pH[c] as number; // 必须在移动前读取当前单元指针
      if (p === P_STOP) break; // 停止单元不构成任何比对列
      cols.push({ op: "M", ca: seqA[i - 1] as string, cb: seqB[j - 1] as string });
      i -= 1;
      j -= 1;
      state = p === P_H_FROM_H ? 1 : p === P_H_FROM_X ? 2 : 3;
    } else if (state === 2) {
      const p = pX[c] as number;
      cols.push({ op: "X", ca: seqA[i - 1] as string, cb: "-" });
      i -= 1;
      if (p === P_X_FROM_H_OPEN) state = 1;
      else if (p === P_X_FROM_X_EXT) state = 2;
      else state = 3;
    } else {
      const p = pY[c] as number;
      cols.push({ op: "Y", ca: "-", cb: seqB[j - 1] as string });
      j -= 1;
      if (p === P_Y_FROM_H_OPEN) state = 1;
      else if (p === P_Y_FROM_X_OPEN) state = 2;
      else state = 3;
    }
  }

  cols.reverse();
  const aStart = i;
  const bStart = j;
  const aEnd = bestI;
  const bEnd = bestJ;

  let alignedA = "";
  let alignedB = "";
  let cigar = "";
  let runOp = "";
  let runLen = 0;
  const flush = () => {
    if (runLen > 0) cigar += `${runLen}${runOp}`;
  };
  for (const col of cols) {
    alignedA += col.ca;
    alignedB += col.cb;
    const op = col.op === "M" ? "M" : col.op === "X" ? "I" : "D";
    if (op === runOp) runLen += 1;
    else {
      flush();
      runOp = op;
      runLen = 1;
    }
  }
  flush();

  return {
    seqA,
    seqB,
    scoreMatrixName: sm.name,
    gapOpen: o,
    gapExtend: e,
    score: best,
    aStart,
    aEnd,
    bStart,
    bEnd,
    alignedA,
    alignedB,
    cigar,
    unalignedPrefixA: seqA.slice(0, aStart),
    unalignedSuffixA: seqA.slice(aEnd),
    unalignedPrefixB: seqB.slice(0, bStart),
    unalignedSuffixB: seqB.slice(bEnd),
  };
}
