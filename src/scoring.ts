import { AA20, ScoreParams, SubstMatrix } from "./types.js";

/** 默认规则：匹配 +2，错配 -1。可通过 params.match / params.mismatch 修改。 */
export const DEFAULT_MATCH = 2;
export const DEFAULT_MISMATCH = -1;
export const DEFAULT_GAP_OPEN = 5;
export const DEFAULT_GAP_EXTEND = 1;

export function defaultParams(overrides: Partial<ScoreParams> = {}): ScoreParams {
  return {
    match: overrides.match ?? DEFAULT_MATCH,
    mismatch: overrides.mismatch ?? DEFAULT_MISMATCH,
    gapOpen: overrides.gapOpen ?? DEFAULT_GAP_OPEN,
    gapExtend: overrides.gapExtend ?? DEFAULT_GAP_EXTEND,
    matrix: overrides.matrix,
  };
}

/**
 * 将输入解析为规范化的 20x20 矩阵。
 * 支持两种形式：
 *  1) 20 个键、每键 20 个分数的对象（缺失字母报错）；
 *  2) 以行为主的二维数组 rows[a][b]，顺序固定为 AA20。
 * 非对称矩阵原样保留，绝不做对称化。
 */
export function normalizeMatrix(input: unknown): { matrix?: SubstMatrix; errors: string[] } {
  const errors: string[] = [];
  if (input === undefined || input === null) return { errors };

  if (Array.isArray(input)) {
    if (input.length !== 20) {
      errors.push(`矩阵必须为 20x20，实际行数 ${input.length}`);
      return { errors };
    }
    const out: Record<string, Record<string, number>> = {};
    for (let i = 0; i < 20; i++) {
      const row = input[i];
      if (!Array.isArray(row) || row.length !== 20) {
        errors.push(`矩阵第 ${i} 行必须是长度 20 的数组`);
        return { errors };
      }
      out[AA20[i]] = {};
      for (let j = 0; j < 20; j++) {
        if (typeof row[j] !== "number" || !Number.isFinite(row[j])) {
          errors.push(`矩阵单元 [${AA20[i]}][${AA20[j]}] 必须为有限数值`);
          return { errors };
        }
        out[AA20[i]][AA20[j]] = row[j];
      }
    }
    return { matrix: out, errors };
  }

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const a of AA20) {
      const row = obj[a];
      if (!row || typeof row !== "object") {
        errors.push(`矩阵缺少行 '${a}'`);
        continue;
      }
      for (const b of AA20) {
        const v = (row as Record<string, unknown>)[b];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          errors.push(`矩阵单元 [${a}][${b}] 缺失或不是有限数值`);
        }
      }
    }
    if (errors.length === 0) {
      const out: Record<string, Record<string, number>> = {};
      for (const a of AA20) {
        out[a] = {};
        for (const b of AA20) out[a][b] = (obj[a] as Record<string, number>)[b];
      }
      return { matrix: out, errors };
    }
  } else {
    errors.push("自定义矩阵必须是对象或 20x20 二维数组");
  }
  return { errors };
}

/** 取得替换分：a 属于序列 A，b 属于序列 B；严格按方向查表。 */
export function substScore(params: ScoreParams, a: string, b: string): number {
  if (params.matrix) return params.matrix[a][b];
  return a === b ? params.match : params.mismatch;
}

export function validateParams(p: ScoreParams): string[] {
  const errors: string[] = [];
  if (!(p.gapOpen > 0)) errors.push("gapOpen 必须为正数");
  if (!(p.gapExtend > 0)) errors.push("gapExtend 必须为正数");
  if (!p.matrix) {
    if (typeof p.match !== "number" || !Number.isFinite(p.match)) errors.push("match 必须为有限数值");
    if (typeof p.mismatch !== "number" || !Number.isFinite(p.mismatch)) errors.push("mismatch 必须为有限数值");
  }
  return errors;
}
