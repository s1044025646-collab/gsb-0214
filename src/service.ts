import type { DatabaseSync } from "node:sqlite";
import {
  addScoreSet,
  addSequence,
  getAlignment,
  getScoreSetVersion,
  getSequenceVersion,
  listScoreSets,
  listSequences,
  parseScoreSet,
  saveAlignment,
} from "./db/db.js";
import { align, DEFAULT_BUDGET } from "./core/align.js";
import { blosum62, defaultMatrix, DEFAULT_GAP_EXTEND, DEFAULT_GAP_OPEN } from "./core/matrix.js";
import { validateGapParams, validateSequence } from "./core/validate.js";
import { verifyAlignment } from "./core/verify.js";
import type { AlignmentBudget, ScoreMatrix } from "./core/types.js";

export function resolveMatrixPreset(preset: string): ScoreMatrix {
  if (preset === "default") return defaultMatrix();
  if (preset === "BLOSUM62" || preset === "blosum62") return blosum62();
  throw new Error(`未知预置矩阵 ${preset}（可选 default / BLOSUM62）`);
}

export interface SolveInput {
  seqARaw?: string;
  seqBRaw?: string;
  seqAName?: string;
  seqBName?: string;
  seqAVersion?: number;
  seqBVersion?: number;
  matrix?: ScoreMatrix;
  preset?: string;
  scoreSetName?: string;
  scoreSetVersion?: number;
  gapOpen?: number;
  gapExtend?: number;
}

export function solve(db: DatabaseSync, input: SolveInput, budget: AlignmentBudget = DEFAULT_BUDGET) {
  let seqA: string;
  let seqB: string;
  if (input.seqAName) {
    const row = getSequenceVersion(db, input.seqAName, input.seqAVersion);
    if (!row) throw new Error(`找不到序列 ${input.seqAName}${input.seqAVersion ? ` 版本 ${input.seqAVersion}` : ""}`);
    seqA = row.seq;
  } else {
    const va = validateSequence(input.seqARaw);
    if (!va.ok) throw new Error("序列 A 非法：\n" + va.errors.join("\n"));
    seqA = va.normalized;
  }
  if (input.seqBName) {
    const row = getSequenceVersion(db, input.seqBName, input.seqBVersion);
    if (!row) throw new Error(`找不到序列 ${input.seqBName}${input.seqBVersion ? ` 版本 ${input.seqBVersion}` : ""}`);
    seqB = row.seq;
  } else {
    const vb = validateSequence(input.seqBRaw);
    if (!vb.ok) throw new Error("序列 B 非法：\n" + vb.errors.join("\n"));
    seqB = vb.normalized;
  }

  let matrix: ScoreMatrix;
  let gapOpen = input.gapOpen ?? DEFAULT_GAP_OPEN;
  let gapExtend = input.gapExtend ?? DEFAULT_GAP_EXTEND;
  if (input.scoreSetName) {
    const row = getScoreSetVersion(db, input.scoreSetName, input.scoreSetVersion);
    if (!row) throw new Error(`找不到评分集 ${input.scoreSetName}`);
    const parsed = parseScoreSet(row);
    matrix = parsed.matrix;
    gapOpen = input.gapOpen ?? parsed.gapOpen;
    gapExtend = input.gapExtend ?? parsed.gapExtend;
  } else if (input.matrix) {
    matrix = input.matrix;
  } else {
    matrix = resolveMatrixPreset(input.preset ?? "default");
  }

  const gapCheck = validateGapParams(gapOpen, gapExtend);
  if ("error" in gapCheck) throw new Error(gapCheck.error);

  // 输入与评分规则在此刻冻结进 alignments 表快照
  const result = align(seqA, seqB, matrix, gapCheck, budget);
  const id = saveAlignment(db, seqA, seqB, matrix, gapCheck.open, gapCheck.extend, result);
  return { id, result, snapshots: { seqA, seqB, matrix, gapOpen: gapCheck.open, gapExtend: gapCheck.extend } };
}

export function verifyStored(db: DatabaseSync, id: number, tamperedCigar?: string) {
  const stored = getAlignment(db, id);
  if (!stored) throw new Error(`找不到比对报告 ${id}`);
  if (stored.noPositive || !stored.result) {
    return { valid: true, noPositive: true, errors: [], note: "该报告为“无正分比对”，无可核验的对齐方案。" };
  }
  const target = tamperedCigar ? { ...stored.result, cigar: tamperedCigar } : stored.result;
  const report = verifyAlignment(
    target,
    stored.snapshots.matrix,
    stored.snapshots.gapOpen,
    stored.snapshots.gapExtend,
  );
  return { ...report, noPositive: false };
}

export function compareStored(db: DatabaseSync, id1: number, id2: number) {
  const a = getAlignment(db, id1);
  const b = getAlignment(db, id2);
  if (!a || !b) throw new Error("对比报告不存在");
  return {
    report1: {
      id: a.id,
      gapOpen: a.snapshots.gapOpen,
      gapExtend: a.snapshots.gapExtend,
      matrix: a.snapshots.matrix.name,
      score: a.result?.score ?? null,
      noPositive: a.noPositive,
    },
    report2: {
      id: b.id,
      gapOpen: b.snapshots.gapOpen,
      gapExtend: b.snapshots.gapExtend,
      matrix: b.snapshots.matrix.name,
      score: b.result?.score ?? null,
      noPositive: b.noPositive,
    },
    sameInput:
      a.snapshots.seqA === b.snapshots.seqA && a.snapshots.seqB === b.snapshots.seqB,
    sameRules:
      JSON.stringify(a.snapshots.matrix) === JSON.stringify(b.snapshots.matrix) &&
      a.snapshots.gapOpen === b.snapshots.gapOpen &&
      a.snapshots.gapExtend === b.snapshots.gapExtend,
    scoreDelta: (a.result?.score ?? 0) - (b.result?.score ?? 0),
  };
}

export {
  addScoreSet,
  addSequence,
  getAlignment,
  getScoreSetVersion,
  getSequenceVersion,
  listScoreSets,
  listSequences,
};
