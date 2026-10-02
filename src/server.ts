import express from "express";
import { pathToFileURL } from "node:url";
import * as db from "./db.js";
import { solve, recheckReport, diffParams } from "./service.js";
import { verifyAlignment } from "./verify.js";
import { cleanSequence } from "./validate.js";
import { defaultParams, normalizeMatrix, validateParams } from "./scoring.js";
import { BUDGET_MAX_CELLS, BUDGET_MAX_LENGTH } from "./types.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, budget: { maxLength: BUDGET_MAX_LENGTH, maxCells: BUDGET_MAX_CELLS } });
});

// 序列导入
app.post("/sequences", (req, res) => {
  const { name, seq } = req.body || {};
  if (typeof name !== "string" || !name) return res.status(400).json({ errors: ["缺少 name"] });
  const c = cleanSequence(seq, name);
  if (!c.ok) return res.status(400).json({ errors: c.errors });
  const row = db.upsertSequence(name, c.seq);
  res.json(row);
});

app.get("/sequences", (req, res) => {
  res.json(db.listSequenceVersions(typeof req.query.name === "string" ? req.query.name : undefined));
});

app.get("/sequences/:id", (req, res) => {
  const row = db.getSequenceVersion(Number(req.params.id));
  if (!row) return res.status(404).json({ errors: ["不存在"] });
  res.json(row);
});

// 评分参数导入
app.post("/params", (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== "string" || !name) return res.status(400).json({ errors: ["缺少 name"] });
  const base = defaultParams();
  const body = req.body.params || req.body;
  const params = {
    match: body.match ?? base.match,
    mismatch: body.mismatch ?? base.mismatch,
    gapOpen: body.gapOpen ?? base.gapOpen,
    gapExtend: body.gapExtend ?? base.gapExtend,
  } as any;
  if (body.matrix !== undefined) {
    const { matrix, errors } = normalizeMatrix(body.matrix);
    if (errors.length) return res.status(400).json({ errors });
    params.matrix = matrix;
  }
  const errs = validateParams(params);
  if (errs.length) return res.status(400).json({ errors: errs });
  res.json(db.saveParams(name, params));
});

app.get("/params", (_req, res) => res.json(db.listParams()));
app.get("/params/:id", (req, res) => {
  const row = db.getParams(Number(req.params.id));
  if (!row) return res.status(404).json({ errors: ["不存在"] });
  res.json(row);
});

// 求解
app.post("/align", (req, res) => {
  const out = solve(req.body || {});
  if (out.errors) return res.status(400).json({ errors: out.errors });
  res.json({ reportId: out.reportId, result: out.result, verification: out.verification });
});

// 回溯摘要
app.get("/reports/:id", (req, res) => {
  const row = db.getReport(Number(req.params.id));
  if (!row) return res.status(404).json({ errors: ["不存在"] });
  res.json(row);
});

app.get("/reports", (_req, res) => res.json(db.listReports()));

// 外部方案核验：可对报告，也可对请求体自带的证据做核验
app.post("/verify", (req, res) => {
  const { reportId, aSeq, bSeq, alignment, params } = req.body || {};
  if (reportId !== undefined) return res.json(recheckReport(Number(reportId)));
  if (!aSeq || !bSeq || !alignment || !params) {
    return res.status(400).json({ errors: ["需要 reportId 或 {aSeq,bSeq,alignment,params}"] });
  }
  res.json({ verification: verifyAlignment(aSeq, bSeq, alignment, params, req.body.score) });
});

// 参数版本比较
app.get("/params-diff/:id1/:id2", (req, res) => {
  const out = diffParams(Number(req.params.id1), Number(req.params.id2));
  if (out.errors) return res.status(404).json(out);
  res.json(out.diff);
});

// JSON 导出
app.get("/export", (_req, res) => {
  res.json({
    sequences: db.listSequenceVersions(),
    params: db.listParams(),
    reports: db.listReports(),
  });
});

const port = Number(process.env.PORT || process.env.ALIGN_PORT || 3000);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  db.getDb();
  app.listen(port, () => {
    console.log(`蛋白质局部比对服务已启动: http://localhost:${port}  数据目录: ${db.dbPath()}`);
  });
}

export { app };
