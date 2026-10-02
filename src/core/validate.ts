import { AA20 } from "./types.js";

const AA_SET = new Set<string>(AA20);

export interface ValidationResult {
  ok: boolean;
  normalized: string;
  errors: string[];
}

/**
 * 校验蛋白质序列：仅允许二十种标准氨基酸字母（大小写不敏感，
 * 内部统一转大写）。不识别 B、Z、X、*、空白等任何扩展字母。
 * 空序列是显式的错误结果，而不是空的合法比对。
 */
export function validateSequence(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== "string") {
    return { ok: false, normalized: "", errors: ["序列必须是字符串"] };
  }
  if (raw.length === 0) {
    return { ok: false, normalized: "", errors: ["序列为空：长度必须大于 0"] };
  }
  const upper = raw.toUpperCase();
  const bad: string[] = [];
  for (let i = 0; i < upper.length; i++) {
    const ch = upper[i] as string;
    if (!AA_SET.has(ch)) {
      bad.push(`位置 ${i} 的字符 '${raw[i] as string}' 不是二十种标准氨基酸之一`);
    }
  }
  if (bad.length > 0) {
    errors.push(...bad);
  }
  return { ok: errors.length === 0, normalized: upper, errors };
}

export function validateGapParams(open: unknown, extend: unknown): { open: number; extend: number } | { error: string } {
  if (typeof open !== "number" || typeof extend !== "number" ||
      !Number.isFinite(open) || !Number.isFinite(extend)) {
    return { error: "缺口 open/extend 必须是有限数值" };
  }
  if (!Number.isInteger(open) || !Number.isInteger(extend)) {
    return { error: "缺口 open/extend 必须是整数（成本单位）" };
  }
  if (open <= 0 || extend <= 0) {
    return { error: "缺口 open 与 extend 成本都必须为正数" };
  }
  return { open, extend };
}
