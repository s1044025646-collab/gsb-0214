import { AlignResult, Alignment, ScoreParams } from "./types.js";
import { substScore } from "./scoring.js";
import { cleanSequence } from "./validate.js";

export interface VerifyReport {
  valid: boolean;
  recomputedScore: number | null;
  declaredScore: number | null;
  scoreMatches: boolean;
  problems: string[];
  note: string;
}

/**
 * 独立的外部比对核验器：不读取 DP 表，仅凭证据逐列重算。
 * 逐列重算替换分；把连续的 I 或连续的 D 归并为一个缺口，
 * 长度 L 扣 open+(L-1)*extend。核对坐标、序列内容与操作串相互一致。
 *
 * 核验通过只说明“该证据合法且分数自洽”，只有完整动态规划才能证明其为全局最高分。
 */
export function verifyAlignment(
  aRaw: string,
  bRaw: string,
  alignment: Alignment,
  params: ScoreParams,
  declaredScore?: number,
): VerifyReport {
  const problems: string[] = [];
  const ca = cleanSequence(aRaw, "序列A");
  const cb = cleanSequence(bRaw, "序列B");
  if (!ca.ok || !cb.ok) {
    return mk(false, null, declaredScore ?? null, false, [...ca.errors, ...cb.errors]);
  }
  const A = ca.seq;
  const B = cb.seq;
  const { alignedA: ga, alignedB: gb, ops, cigar, coords, unaligned } = alignment;

  if (ga.length !== gb.length || ga.length !== ops.length) {
    problems.push(`对齐串与操作串长度不一致：${ga.length} / ${gb.length} / ${ops.length}`);
  }
  if (!/^[MID]+$/.test(ops)) problems.push("操作串只能包含 M/I/D");

  // 逐列核对操作与残基/缺口的对应关系及原序列内容
  let ai = coords.a[0];
  let bi = coords.b[0];
  let subst = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const x = ga[k];
    const y = gb[k];
    if (op === "M") {
      if (x === "-" || y === "-") problems.push(`列 ${k} 标记 M 但出现缺口`);
      if (x !== A[ai]) problems.push(`列 ${k} A 残基 '${x}' 与原序列位置 ${ai} 的 '${A[ai]}' 不符`);
      if (y !== B[bi]) problems.push(`列 ${k} B 残基 '${y}' 与原序列位置 ${bi} 的 '${B[bi]}' 不符`);
      subst += substScore(params, x, y);
      ai++; bi++;
    } else if (op === "I") {
      if (x === "-" || y !== "-") problems.push(`列 ${k} 标记 I（只消费 A）但缺口布局错误`);
      if (x !== A[ai]) problems.push(`列 ${k} A 残基 '${x}' 与原序列位置 ${ai} 的 '${A[ai]}' 不符`);
      ai++;
    } else {
      if (x !== "-" || y === "-") problems.push(`列 ${k} 标记 D（只消费 B）但缺口布局错误`);
      if (y !== B[bi]) problems.push(`列 ${k} B 残基 '${y}' 与原序列位置 ${bi} 的 '${B[bi]}' 不符`);
      bi++;
    }
  }

  // 坐标半开区间与消费位置一致
  if (ai !== coords.a[1]) problems.push(`A 结束坐标 ${coords.a[1]} 与实际消费到的 ${ai} 不符`);
  if (bi !== coords.b[1]) problems.push(`B 结束坐标 ${coords.b[1]} 与实际消费到的 ${bi} 不符`);
  if (coords.a[0] < 0 || coords.a[1] > A.length || coords.a[0] > coords.a[1]) {
    problems.push("A 坐标越界或顺序错误");
  }
  if (coords.b[0] < 0 || coords.b[1] > B.length || coords.b[0] > coords.b[1]) {
    problems.push("B 坐标越界或顺序错误");
  }

  // 未对齐前后缀内容核对（这些残基不计内部缺口罚分）
  if (unaligned.aPrefix !== A.slice(0, coords.a[0])) problems.push("A 前缀未对齐段与原序列不符");
  if (unaligned.bPrefix !== B.slice(0, coords.b[0])) problems.push("B 前缀未对齐段与原序列不符");
  if (unaligned.aSuffix !== A.slice(coords.a[1])) problems.push("A 后缀未对齐段与原序列不符");
  if (unaligned.bSuffix !== B.slice(coords.b[1])) problems.push("B 后缀未对齐段与原序列不符");

  // CIGAR 与 ops 互检
  if (cigarFromOps(ops) !== cigar) problems.push(`CIGAR '${cigar}' 与操作串 '${ops}' 不一致`);

  const bd = scoreOperations(ops, params, A, B, coords.a[0], coords.b[0]);
  if (bd.substitution !== subst) problems.push("替换分内部分项不一致");
  const score = bd.substitution - bd.gapPenalty;
  const scoreMatches = declaredScore === undefined ? true : score === declaredScore;
  if (!scoreMatches) problems.push(`重算总分 ${score} 与声明总分 ${declaredScore} 不符`);

  const note = "核验通过仅表示证据合法且分数自洽；是否为最高分须由完整动态规划证明。";
  return mk(problems.length === 0 && scoreMatches, score, declaredScore ?? null, scoreMatches, problems, note, bd);
}

/** 依据操作串与原序列片段独立重算分项得分（替换分、缺口开放/延长次数与罚分）。 */
export function scoreOperations(
  ops: string,
  params: ScoreParams,
  A: string,
  B: string,
  aStart: number,
  bStart: number,
): { substitution: number; gapOpenCount: number; gapExtendCount: number; gapPenalty: number } {
  let substitution = 0;
  let ai = aStart;
  let bi = bStart;
  for (let k = 0; k < ops.length; k++) {
    if (ops[k] === "M") { substitution += substScore(params, A[ai], B[bi]); ai++; bi++; }
    else if (ops[k] === "I") { ai++; }
    else { bi++; }
  }
  let gapPenalty = 0;
  let gapOpenCount = 0;
  let gapExtendCount = 0;
  for (let k = 0; k < ops.length; ) {
    const op = ops[k];
    if (op === "M") { k++; continue; }
    let L = 0;
    while (ops[k] === op) { L++; k++; }
    gapPenalty += params.gapOpen + (L - 1) * params.gapExtend;
    gapOpenCount += 1;
    gapExtendCount += L - 1;
  }
  return { substitution, gapOpenCount, gapExtendCount, gapPenalty };
}

function mk(
  valid: boolean, recomputedScore: number | null, declaredScore: number | null,
  scoreMatches: boolean, problems: string[], note = "",
  breakdown?: { substitution: number; gapOpenCount: number; gapExtendCount: number; gapPenalty: number },
): VerifyReport & { breakdown?: unknown } {
  return {
    valid, recomputedScore, declaredScore, scoreMatches, problems,
    note: note || "核验通过仅表示证据合法且分数自洽；是否为最高分须由完整动态规划证明。",
    ...(breakdown ? { breakdown } : {}),
  };
}

export function cigarFromOps(ops: string): string {
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

/** 便捷封装：直接核验一次 align() 结果。 */
export function verifyResult(aRaw: string, bRaw: string, result: AlignResult): VerifyReport {
  if (result.status !== "ok" || !result.alignment) {
    return mk(false, null, result.score, false, [`结果状态为 ${result.status}，无可核验比对`]);
  }
  return verifyAlignment(aRaw, bRaw, result.alignment, result.paramsSnapshot, result.score);
}
