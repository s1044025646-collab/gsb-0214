import type { AlignmentResult, ScoreMatrix } from "./types.js";
import { MatrixLookup } from "./matrix.js";

export interface VerificationReport {
  valid: boolean;
  errors: string[];
  recomputedScore: number | null;
  claimedScore: number | null;
  note: string;
}

/**
 * 独立的外部核验器：不读取任何 DP 矩阵，只根据
 * 原序列 + 坐标 + 带缺口对齐串 + CIGAR 逐列重算。
 *
 * 注意：核验通过只说明该方案在输入与规则下证据合法；
 * 只有完整动态规划（或等价穷举）才能证明它是最高分方案。
 */
export function verifyAlignment(
  result: AlignmentResult,
  sm: ScoreMatrix,
  gapOpen: number,
  gapExtend: number,
): VerificationReport {
  const errors: string[] = [];
  const { seqA, seqB, alignedA, alignedB, cigar } = result;
  const note =
    "核验通过仅表示对齐串、坐标、CIGAR 与重算得分相互一致（证据合法）；" +
    "不能证明该方案是最高分，最优性需要完整动态规划。";

  if (alignedA.length !== alignedB.length) {
    errors.push(`两条带缺口对齐串长度不一致：${alignedA.length} vs ${alignedB.length}`);
  }
  if (alignedA.length === 0) errors.push("带缺口对齐串为空");

  // 解析 CIGAR
  const ops: { len: number; op: string }[] = [];
  const re = /(\d+)([MIDNSHP=X])/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(cigar)) !== null) {
    const len = Number(m[1]);
    const op = m[2] as string;
    if (len <= 0) errors.push(`CIGAR 操作 ${op} 长度必须为正`);
    ops.push({ len, op });
    consumed += len;
  }
  if (ops.length === 0 || ops.some((o) => o.op === "N" || o.op === "S" || o.op === "H" || o.op === "P")) {
    if (ops.length === 0) errors.push("CIGAR 无法解析或为空");
    else errors.push("CIGAR 含本服务不产生的操作（N/S/H/P）");
  }
  if (consumed !== alignedA.length) {
    errors.push(`CIGAR 总列数 ${consumed} 与对齐串列数 ${alignedA.length} 不一致`);
  }

  // 逐列重建，并与 CIGAR 对照
  const lookup = new MatrixLookup(sm);
  let score = 0;
  let ai = 0;
  let bi = 0;
  let colIndex = 0;
  let firstCol = true;
  let lastWasGap = false;
  for (const { len, op } of ops) {
    for (let k = 0; k < len; k++) {
      const ca = alignedA[colIndex];
      const cb = alignedB[colIndex];
      if (ca === undefined || cb === undefined) {
        errors.push(`CIGAR 在第 ${colIndex + 1} 列超出对齐串范围`);
        colIndex++;
        continue;
      }
      const isGapA = ca === "-";
      const isGapB = cb === "-";
      if (isGapA && isGapB) {
        errors.push(`第 ${colIndex + 1} 列两条序列同时为缺口，非法`);
      }
      if (firstCol && (isGapA || isGapB)) {
        errors.push("局部比对第一列不允许是缺口（端缺口必须归入未对齐残基）");
      }
      const expectOp = !isGapA && !isGapB ? "M" : isGapA ? "D" : "I";
      if (expectOp !== op) {
        errors.push(`第 ${colIndex + 1} 列字符 (${ca}/${cb}) 与 CIGAR 操作 ${op} 矛盾，应为 ${expectOp}`);
      }
      if (!isGapA && !isGapB) {
        try {
          score += lookup.score(ca, cb);
        } catch {
          errors.push(`第 ${colIndex + 1} 列字符 (${ca}/${cb}) 不在评分矩阵字母表中`);
        }
        lastWasGap = false;
      } else if (isGapA) {
        // 消费 B：A 上的缺口
        // 连续缺口长度 L 代价 = open + (L-1)*extend：首列 open，后续列 extend
        score += lastWasGap === false ? -gapOpen : -gapExtend;
        lastWasGap = true;
      } else {
        // 消费 A：B 上的缺口
        score += lastWasGap === false ? -gapOpen : -gapExtend;
        lastWasGap = true;
      }
      if (!isGapA) {
        if (ca !== seqA[result.aStart + ai]) {
          errors.push(`A 第 ${ai} 个对齐残基与原序列 [aStart+${ai}] 不一致`);
        }
        ai++;
      }
      if (!isGapB) {
        if (cb !== seqB[result.bStart + bi]) {
          errors.push(`B 第 ${bi} 个对齐残基与原序列 [bStart+${bi}] 不一致`);
        }
        bi++;
      }
      colIndex++;
      firstCol = false;
    }
  }

  // 末列不得为缺口
  const lastA = alignedA[alignedA.length - 1];
  const lastB = alignedB[alignedB.length - 1];
  if (lastA === "-" || lastB === "-") {
    errors.push("局部比对最后一列不允许是缺口（端缺口必须归入未对齐残基）");
  }

  // 坐标一致性
  const checkRange = (name: string, start: number, end: number, seqLen: number, used: number) => {
    if (!Number.isInteger(start) || !Number.isInteger(end)) errors.push(`${name} 坐标必须为整数`);
    if (start < 0 || end < start || end > seqLen) {
      errors.push(`${name} 半开区间 [${start}, ${end}) 越界（序列长度 ${seqLen}）`);
    }
    if (end - start !== used) {
      errors.push(`${name} 坐标跨度 ${end - start} 与对齐实际消费残基数 ${used} 不一致`);
    }
  };
  checkRange("A", result.aStart, result.aEnd, seqA.length, ai);
  checkRange("B", result.bStart, result.bEnd, seqB.length, bi);

  // 未对齐残基：两端未使用残基单独标注，且不计入内部缺口
  if (result.unalignedPrefixA !== seqA.slice(0, result.aStart)) {
    errors.push("unalignedPrefixA 与原序列前缀不一致");
  }
  if (result.unalignedSuffixA !== seqA.slice(result.aEnd)) {
    errors.push("unalignedSuffixA 与原序列后缀不一致");
  }
  if (result.unalignedPrefixB !== seqB.slice(0, result.bStart)) {
    errors.push("unalignedPrefixB 与原序列前缀不一致");
  }
  if (result.unalignedSuffixB !== seqB.slice(result.bEnd)) {
    errors.push("unalignedSuffixB 与原序列后缀不一致");
  }

  if (result.gapOpen !== gapOpen || result.gapExtend !== gapExtend) {
    errors.push("报告中缺口参数与核验所用参数不一致");
  }
  if (result.score !== score) {
    errors.push(`声明总分 ${result.score} 与逐列重算总分 ${score} 不一致`);
  }

  return {
    valid: errors.length === 0,
    errors,
    recomputedScore: errors.some((x) => x.includes("越界") || x.includes("超出")) ? null : score,
    claimedScore: result.score,
    note,
  };
}
