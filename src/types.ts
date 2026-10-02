// 二十种标准氨基酸字母（单字母代码，大写）
export const AA20: readonly string[] = [
  "A", "R", "N", "D", "C", "Q", "E", "G", "H", "I",
  "L", "K", "M", "F", "P", "S", "T", "W", "Y", "V",
];

/** 替换得分矩阵：matrix[a][b]，a 为序列 A（query）残基，b 为序列 B（target）残基。非对称矩阵严格按此方向使用。 */
export type SubstMatrix = Readonly<Record<string, Record<string, number>>>;

export interface ScoreParams {
  /** 默认匹配分（仅在未提供完整自定义矩阵时使用） */
  match: number;
  /** 默认错配分（通常为负） */
  mismatch: number;
  /** 缺口开放代价（正数），长度 L 的连续缺口总代价为 open + (L-1)*extend */
  gapOpen: number;
  /** 缺口延长代价（正数） */
  gapExtend: number;
  /** 可选的完整 20x20 自定义替换矩阵；提供后 match/mismatch 被忽略 */
  matrix?: SubstMatrix;
}

/** 操作语义：M=两列残基配对（同时消费 A、B）；I=A 有残基而 B 为缺口（只消费 A）；D=B 有残基而 A 为缺口（只消费 B） */
export type AlignOp = "M" | "I" | "D";

export interface Alignment {
  /** 带缺口的序列 A 对齐串 */
  alignedA: string;
  /** 带缺口的序列 B 对齐串 */
  alignedB: string;
  /** 逐列操作串，字符取自 M/I/D */
  ops: string;
  /** CIGAR 式游程编码操作串，如 3M2I4M */
  cigar: string;
  /** 零起始、半开区间 [start,end)，指向原序列 */
  coords: { a: [number, number]; b: [number, number] };
  /** 局部比对两端未参与对齐的残基（不计缺口罚分） */
  unaligned: {
    aPrefix: string; aSuffix: string;
    bPrefix: string; bSuffix: string;
  };
  /** 核验器重算的分项得分 */
  breakdown: { substitution: number; gapOpenCount: number; gapExtendCount: number; gapPenalty: number };
}

export interface AlignResult {
  status: "ok" | "invalid_input" | "rejected_budget";
  /** 是否存在正分比对；最高分为 0 时为 false 且不输出 alignment */
  positive: boolean;
  score: number;
  alignment?: Alignment;
  errors?: string[];
  budget?: { maxLength: number; maxCells: number; cells: number; lenA: number; lenB: number };
  paramsSnapshot: ScoreParams;
}

/** 公开预算：超过长度或单元数上限时拒绝输出“假定最优”结果 */
export const BUDGET_MAX_LENGTH = 2000;
export const BUDGET_MAX_CELLS = 1_000_000;
