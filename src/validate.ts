import { AA20 } from "./types.js";

const AA_SET = new Set(AA20);

export interface CleanSeq {
  ok: boolean;
  /** 去除空白并大写后的序列 */
  seq: string;
  errors: string[];
}

/** 清洗并校验序列：空序列与非法字符给出明确结果（错误含零起始位置） */
export function cleanSequence(input: unknown, label = "sequence"): CleanSeq {
  const errors: string[] = [];
  if (typeof input !== "string") {
    return { ok: false, seq: "", errors: [`${label} 必须是字符串`] };
  }
  const seq = input.replace(/\s+/g, "").toUpperCase();
  if (seq.length === 0) {
    errors.push(`${label} 为空序列：空序列无法产生正分局部比对`);
  }
  for (let i = 0; i < seq.length; i++) {
    if (!AA_SET.has(seq[i])) {
      errors.push(`${label} 位置 ${i} 含非法字符 '${seq[i]}'，仅允许二十种标准氨基酸字母：${AA20.join("")}`);
    }
  }
  return { ok: errors.length === 0, seq, errors };
}
