import { align } from "./align.js";
import { verifyAlignment, VerifyReport } from "./verify.js";
import { defaultParams, normalizeMatrix, validateParams } from "./scoring.js";
import { ScoreParams } from "./types.js";
import { cleanSequence } from "./validate.js";
import * as db from "./db.js";

export interface SolveInput {
  aName?: string;
  bName?: string;
  aSeq?: string;
  bSeq?: string;
  aVersionId?: number;
  bVersionId?: number;
  paramsId?: number;
  params?: Partial<ScoreParams> & { matrix?: unknown };
  paramName?: string;
}

function buildParams(input: SolveInput): { params?: ScoreParams; paramId?: number; errors: string[] } {
  if (input.paramsId) {
    const row = db.getParams(input.paramsId);
    if (!row) return { errors: [`评分参数版本 ${input.paramsId} 不存在`] };
    return { params: row.payload, paramId: row.id, errors: [] };
  }
  const base = defaultParams();
  const p: ScoreParams = {
    match: input.params?.match ?? base.match,
    mismatch: input.params?.mismatch ?? base.mismatch,
    gapOpen: input.params?.gapOpen ?? base.gapOpen,
    gapExtend: input.params?.gapExtend ?? base.gapExtend,
  };
  if (input.params?.matrix !== undefined) {
    const { matrix, errors } = normalizeMatrix(input.params.matrix);
    if (errors.length) return { errors };
    p.matrix = matrix;
  }
  const errors = validateParams(p);
  if (errors.length) return { errors };
  const saved = db.saveParams(input.paramName || "ad-hoc", p);
  return { params: p, paramId: saved.id, errors: [] };
}

function resolveSeq(
  name: string, inline?: string, versionId?: number, fallbackName?: string,
): { seq?: string; versionId?: number; errors: string[] } {
  if (versionId !== undefined) {
    const row = db.getSequenceVersion(versionId);
    if (!row) return { errors: [`${name} 序列版本 ${versionId} 不存在`] };
    return { seq: row.seq, versionId: row.id, errors: [] };
  }
  if (inline !== undefined) {
    const c = cleanSequence(inline, name);
    if (!c.ok) return { errors: c.errors };
    const row = db.upsertSequence(fallbackName || `${name}-inline`, c.seq);
    return { seq: c.seq, versionId: row.id, errors: [] };
  }
  return { errors: [`缺少 ${name}（内联序列或版本 ID）`] };
}

export interface SolveOutput {
  reportId?: number;
  result?: import("./types.js").AlignResult;
  verification?: VerifyReport;
  errors?: string[];
}

/** 完整求解管线：冻结序列版本与评分规则 -> DP -> 独立核验 -> 存报告。 */
export function solve(input: SolveInput): SolveOutput {
  const a = resolveSeq("序列A", input.aSeq, input.aVersionId, input.aName);
  const b = resolveSeq("序列B", input.bSeq, input.bVersionId, input.bName);
  const pp = buildParams(input);
  const errors = [...a.errors, ...b.errors, ...pp.errors];
  if (errors.length || !a.seq || !b.seq || !pp.params) return { errors };

  const result = align(a.seq, b.seq, pp.params);
  const verification = result.alignment
    ? verifyAlignment(a.seq, b.seq, result.alignment, pp.params, result.score)
    : undefined;

  const reportId = db.saveReport(
    a.versionId!, b.versionId!, pp.paramId!, a.seq, b.seq, result,
  );
  return { reportId, result, verification };
}

/** 服务重启后：读取冻结的旧报告，仅依据存储证据重新外部核验（不重跑 DP）。 */
export function recheckReport(reportId: number): { report?: db.ReportRow; verification?: VerifyReport; errors?: string[] } {
  const report = db.getReport(reportId);
  if (!report) return { errors: [`报告 ${reportId} 不存在`] };
  const params = db.getParams(report.score_param_id)?.payload || report.result.paramsSnapshot;
  const verification = report.result.alignment
    ? verifyAlignment(report.a_seq, report.b_seq, report.result.alignment, params, report.result.score)
    : {
        valid: report.result.status === "ok" && !report.result.positive,
        recomputedScore: report.result.score,
        declaredScore: report.result.score,
        scoreMatches: true,
        problems: [],
        note: "无正分比对结果，无需逐列核验。",
      };
  return { report, verification };
}

export interface ParamDiff {
  name: string;
  v1: number;
  v2: number;
  changes: Array<{ field: string; from: unknown; to: unknown }>;
}

/** 比较两套评分参数版本（矩阵按单元比较，非对称方向保留）。 */
export function diffParams(id1: number, id2: number): { diff?: ParamDiff; errors?: string[] } {
  const p1 = db.getParams(id1);
  const p2 = db.getParams(id2);
  if (!p1 || !p2) return { errors: ["参数版本不存在"] };
  const changes: ParamDiff["changes"] = [];
  for (const field of ["match", "mismatch", "gapOpen", "gapExtend"] as const) {
    if (p1.payload[field] !== p2.payload[field]) {
      changes.push({ field, from: p1.payload[field], to: p2.payload[field] });
    }
  }
  const m1 = p1.payload.matrix;
  const m2 = p2.payload.matrix;
  if ((m1 === undefined) !== (m2 === undefined)) {
    changes.push({ field: "matrixPresence", from: !!m1, to: !!m2 });
  } else if (m1 && m2) {
    for (const a of Object.keys(m1)) {
      for (const b of Object.keys(m1[a])) {
        if (m1[a][b] !== m2[a][b]) changes.push({ field: `matrix[${a}][${b}]`, from: m1[a][b], to: m2[a][b] });
      }
    }
  }
  return { diff: { name: p1.name, v1: p1.version, v2: p2.version, changes } };
}
