export const AA20 = [
  "A", "R", "N", "D", "C",
  "Q", "E", "G", "H", "I",
  "L", "K", "M", "F", "P",
  "S", "T", "W", "Y", "V",
] as const;

export type AminoAcid = (typeof AA20)[number];

export interface GapParams {
  open: number;
  extend: number;
}

/**
 * 替换得分矩阵。matrix[a][b] 表示序列 A 位置的氨基酸为 a、
 * 序列 B 位置的氨基酸为 b 时的得分。
 * 非对称矩阵严格按输入方向使用，不做任何对称化。
 */
export interface ScoreMatrix {
  name: string;
  alphabet: string[];
  matrix: number[][];
}

export interface AlignmentBudget {
  maxLength: number;
  maxCells: number;
}

export interface AlignmentSegment {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  alignedA: string;
  alignedB: string;
  cigar: string;
  score: number;
  unalignedPrefixA: string;
  unalignedSuffixA: string;
  unalignedPrefixB: string;
  unalignedSuffixB: string;
}

export interface AlignmentResult extends AlignmentSegment {
  seqA: string;
  seqB: string;
  scoreMatrixName: string;
  gapOpen: number;
  gapExtend: number;
}
