import { AA20, type ScoreMatrix } from "./types.js";

/**
 * 默认评分：匹配 +2，错配 -1（明确公开的默认值）。
 * 缺口默认 open=5、extend=1（成本，均为正）。
 */
export const DEFAULT_MATCH = 2;
export const DEFAULT_MISMATCH = -1;
export const DEFAULT_GAP_OPEN = 5;
export const DEFAULT_GAP_EXTEND = 1;

export function defaultMatrix(match = DEFAULT_MATCH, mismatch = DEFAULT_MISMATCH): ScoreMatrix {
  const m = AA20.map((a) =>
    AA20.map((b) => (a === b ? match : mismatch)),
  );
  return { name: `match${match}_mismatch${mismatch}`, alphabet: [...AA20], matrix: m };
}

function row(s: string): number[] {
  return s.trim().split(/\s+/).map(Number);
}

/**
 * BLOSUM62（NCBI 标准顺序 A R N D C Q E G H I L K M F P S T W Y V），
 * 作为可选预置；非对称自定义矩阵由调用方完整提供。
 */
export function blosum62(): ScoreMatrix {
  const lines = [
    " 4 -1 -2 -2  0 -1 -1  0 -2 -1 -1 -1 -1 -2 -1  1  0 -3 -2  0",
    "-1  5  0 -2 -3  1  0 -2  0 -3 -2  2 -1 -3 -2 -1 -1 -3 -2 -3",
    "-2  0  6  1 -3  0  0  0  1 -3 -3  0 -2 -3 -2  1  0 -4 -2 -3",
    "-2 -2  1  6 -3  0  2 -1 -1 -3 -4 -1 -3 -3 -1  0 -1 -4 -3 -3",
    " 0 -3 -3 -3  9 -3 -4 -3 -3 -1 -1 -3 -1 -2 -3 -1 -1 -2 -2 -1",
    "-1  1  0  0 -3  5  2 -2  0 -3 -2  1  0 -3 -1  0 -1 -2 -1 -2",
    "-1  0  0  2 -4  2  5 -2  0 -3 -3  1 -2 -3 -1  0 -1 -3 -2 -2",
    " 0 -2  0 -1 -3 -2 -2  6 -2 -4 -4 -2 -3 -3 -2  0 -2 -2 -3 -3",
    "-2  0  1 -1 -3  0  0 -2  8 -3 -3 -1 -2 -1 -2 -1 -2 -2  2 -3",
    "-1 -3 -3 -3 -1 -3 -3 -4 -3  4  2 -3  1  0 -3 -2 -1 -3 -1  3",
    "-1 -2 -3 -4 -1 -2 -3 -4 -3  2  4 -2  2  0 -3 -2 -1 -2 -1  1",
    "-1  2  0 -1 -3  1  1 -2 -1 -3 -2  5 -1 -3 -1  0 -1 -3 -2 -2",
    "-1 -1 -2 -3 -1  0 -2 -3 -2  1  2 -1  5  0 -2 -1 -1 -1 -1  1",
    "-2 -3 -3 -3 -2 -3 -3 -3 -1  0  0 -3  0  6 -4 -2 -2  1  3 -1",
    "-1 -2 -2 -1 -3 -1 -1 -2 -2 -3 -3 -1 -2 -4  7 -1 -1 -4 -3 -2",
    " 1 -1  1  0 -1  0  0  0 -1 -2 -2  0 -1 -2 -1  4  1 -3 -2 -2",
    " 0 -1  0 -1 -1 -1 -1 -2 -2 -1 -1 -1 -1 -2 -1  1  5 -2 -2  0",
    "-3 -3 -4 -4 -2 -2 -3 -2 -2 -3 -2 -3 -1  1 -4 -3 -2 11  2 -3",
    "-2 -2 -2 -3 -2 -1 -2 -3  2 -1 -1 -2 -1  3 -3 -2 -2  2  7 -1",
    " 0 -3 -3 -3 -1 -2 -2 -3 -3  3  1 -2  1 -1 -2 -2  0 -3 -1  4",
  ];
  return { name: "BLOSUM62", alphabet: [...AA20], matrix: lines.map(row) };
}

export function validateMatrix(s: ScoreMatrix): string[] {
  const errors: string[] = [];
  const n = s.alphabet.length;
  if (n === 0) errors.push("字母表为空");
  if (new Set(s.alphabet).size !== n) errors.push("字母表存在重复字符");
  for (const c of s.alphabet) {
    if (typeof c !== "string" || c.length !== 1) errors.push(`字母表项非法: ${String(c)}`);
  }
  if (s.matrix.length !== n) {
    errors.push(`矩阵行数 ${s.matrix.length} 与字母表大小 ${n} 不一致`);
  }
  for (let i = 0; i < s.matrix.length; i++) {
    const r = s.matrix[i] as number[];
    if (!Array.isArray(r) || r.length !== n) {
      errors.push(`矩阵第 ${i} 行长度必须为 ${n}`);
      continue;
    }
    for (const v of r) {
      if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
        errors.push("矩阵得分必须是整数");
      }
    }
  }
  return errors;
}

export class MatrixLookup {
  private readonly index = new Map<string, number>();
  constructor(private readonly sm: ScoreMatrix) {
    sm.alphabet.forEach((c, i) => this.index.set(c, i));
  }
  score(a: string, b: string): number {
    const ia = this.index.get(a);
    const ib = this.index.get(b);
    if (ia === undefined || ib === undefined) {
      throw new Error(`矩阵 ${this.sm.name} 缺少字符对 ${a}/${b} 的得分`);
    }
    return (this.sm.matrix[ia] as number[])[ib] as number;
  }
}
