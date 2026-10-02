import {
  AlignResult, Alignment, AlignOp, BUDGET_MAX_CELLS, BUDGET_MAX_LENGTH, ScoreParams,
} from "./types.js";
import { substScore } from "./scoring.js";
import { cleanSequence } from "./validate.js";
import { scoreOperations } from "./verify.js";

/**
 * Smith-Waterman 局部比对 + Gotoh 三状态仿射缺口 DP。
 *
 * 序列 A（query）长度 m，序列 B（target）长度 n，1-based 入表：
 *   H[i][j] = 以 (i,j) 配对列结尾的最高分（允许从 0 重新起步，体现“局部”）
 *   E[i][j] = 以 A 缺口结尾（D 操作，B 残基插入，只消费 B），即对齐串中 A 列为 '-'
 *   F[i][j] = 以 B 缺口结尾（I 操作，A 残基插入，只消费 A），即对齐串中 B 列为 '-'
 *
 * 长度 L 的连续缺口代价 = open + (L-1)*extend（open、extend 均为正）。
 * 递归中 -gapOpen 表示新开长度 1 的缺口；-gapExtend 表示在已有缺口上延长。
 */
export function align(aRaw: string, bRaw: string, params: ScoreParams): AlignResult {
  const ca = cleanSequence(aRaw, "序列A");
  const cb = cleanSequence(bRaw, "序列B");
  const errors: string[] = [...ca.errors, ...cb.errors];
  if (!ca.ok || !cb.ok) {
    return { status: "invalid_input", positive: false, score: 0, errors, paramsSnapshot: params };
  }
  const A = ca.seq;
  const B = cb.seq;
  const m = A.length;
  const n = B.length;
  const cells = m * n;

  if (m > BUDGET_MAX_LENGTH || n > BUDGET_MAX_LENGTH || cells > BUDGET_MAX_CELLS) {
    return {
      status: "rejected_budget", positive: false, score: 0,
      errors: [`超出公开预算：长度上限 ${BUDGET_MAX_LENGTH}，单元数上限 ${BUDGET_MAX_CELLS}`],
      budget: { maxLength: BUDGET_MAX_LENGTH, maxCells: BUDGET_MAX_CELLS, cells, lenA: m, lenB: n },
      paramsSnapshot: params,
    };
  }

  const o = params.gapOpen;
  const e = params.gapExtend;

  const H = new Float64Array((m + 1) * (n + 1));
  const E = new Float64Array((m + 1) * (n + 1));
  const F = new Float64Array((m + 1) * (n + 1));
  // 回溯：H 记录 M/H/E/F/0，E/F 记录该状态是新开缺口(O)还是延长(X)
  const tbH = new Uint8Array((m + 1) * (n + 1));
  const tbE = new Uint8Array((m + 1) * (n + 1));
  const tbF = new Uint8Array((m + 1) * (n + 1));

  const idx = (i: number, j: number) => i * (n + 1) + j;
  const NEG = -1e15;

  // Gotoh 初始化约定：E/F 边界置为 -o（表示“缺口已开放但尚未计延长”），
  // 从边界迈出第一列时 -o-e，之后每列 -e；长度 L 合计 open+(L-1)*extend。
  for (let i = 0; i <= m; i++) {
    E[idx(i, 0)] = i === 0 ? NEG : -o;
    F[idx(i, 0)] = NEG;
  }
  for (let j = 0; j <= n; j++) {
    F[idx(0, j)] = j === 0 ? NEG : -o;
    E[idx(0, j)] = NEG;
  }

  // 确定性并列打破：扫描顺序 i 升序、j 升序；候选优先级 open(0,重启) < extend(1) < match(2)
  let best = 0;
  let bi = 0;
  let bj = 0;
  let bestState = 0; // 1=H 2=E 3=F

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const p = idx(i, j);
      const s = substScore(params, A[i - 1], B[j - 1]);

      // E：A 为缺口，只消费 B[j]。来源 H(i,j-1) 新开长度1=open，或 E(i,j-1) 延长只扣 extend。
      const eOpen = H[idx(i, j - 1)] - o - e;
      const eExt = E[idx(i, j - 1)] - e;
      if (eOpen >= eExt) { E[p] = eOpen; tbE[p] = 0; } else { E[p] = eExt; tbE[p] = 1; }

      // F：B 为缺口，只消费 A[i]。来源 H(i-1,j) 新开长度1=open，或 F(i-1,j) 延长只扣 extend。
      const fOpen = H[idx(i - 1, j)] - o - e;
      const fExt = F[idx(i - 1, j)] - e;
      if (fOpen >= fExt) { F[p] = fOpen; tbF[p] = 0; } else { F[p] = fExt; tbF[p] = 1; }

      // H：配对列。允许从 0 重启（局部比对自由起点）。
      let hv = 0;
      let th = 0;
      const diag = H[idx(i - 1, j - 1)] + s;
      if (diag > 0) { hv = diag; th = 2; }
      if (E[p] > hv) { hv = E[p]; th = 3; }
      if (F[p] > hv) { hv = F[p]; th = 4; }
      H[p] = hv;
      tbH[p] = th;

      // 严格大于才更新：遇到并列时保留先扫描到的单元（i 小优先，再 j 小），保证确定性。
      if (hv > best) { best = hv; bi = i; bj = j; bestState = th === 3 ? 2 : th === 4 ? 3 : 1; }
    }
  }

  const result: AlignResult = {
    status: "ok", positive: best > 0, score: best,
    budget: { maxLength: BUDGET_MAX_LENGTH, maxCells: BUDGET_MAX_CELLS, cells, lenA: m, lenB: n },
    paramsSnapshot: params,
  };

  if (best <= 0) return result; // 最高分为零：没有正分比对，不强行对齐

  // ---------- 回溯 ----------
  const revOps: AlignOp[] = [];
  let i = bi;
  let j = bj;
  let state = bestState; // 1=H 2=E 3=F

  while (i > 0 && j > 0) {
    if (state === 1) {
      const t = tbH[idx(i, j)];
      if (t === 0 || H[idx(i, j)] <= 0) break; // 回到自由起点，比对结束
      if (t === 2) { revOps.push("M"); i--; j--; state = 1; }
      else if (t === 3) { state = 2; } // H 由 E 进入
      else { state = 3; }              // H 由 F 进入
    } else if (state === 2) {
      const open = tbE[idx(i, j)] === 0;
      revOps.push("D"); j--;
      state = open ? 1 : 2; // 新开缺口回到 H；延长则留在 E
    } else {
      const open = tbF[idx(i, j)] === 0;
      revOps.push("I"); i--;
      state = open ? 1 : 3;
    }
  }

  const ops = revOps.reverse().join("");
  const aStart = i;
  const bStart = j;
  let ga = "";
  let gb = "";
  let ai = i;
  let bj2 = j;
  for (const op of ops) {
    if (op === "M") { ga += A[ai++]; gb += B[bj2++]; }
    else if (op === "I") { ga += A[ai++]; gb += "-"; }
    else { ga += "-"; gb += B[bj2++]; }
  }
  const aEnd = ai;
  const bEnd = bj2;

  const cigar = toCigar(ops);
  const breakdown = scoreOperations(ops, params, A, B, aStart, bStart);

  const alignment: Alignment = {
    alignedA: ga,
    alignedB: gb,
    ops,
    cigar,
    coords: { a: [aStart, aEnd], b: [bStart, bEnd] },
    unaligned: {
      aPrefix: A.slice(0, aStart),
      aSuffix: A.slice(aEnd),
      bPrefix: B.slice(0, bStart),
      bSuffix: B.slice(bEnd),
    },
    breakdown,
  };
  result.alignment = alignment;
  return result;
}

/** ops(M/I/D) -> CIGAR 游程串。M 同时消费两条；I 只消费 A；D 只消费 B。 */
export function toCigar(ops: string): string {
  let out = "";
  let run = 0;
  let cur = "";
  for (const op of ops + "|") {
    if (op === cur) { run++; continue; }
    if (run > 0) out += `${run}${cur}`;
    cur = op; run = 1;
  }
  return out;
}
