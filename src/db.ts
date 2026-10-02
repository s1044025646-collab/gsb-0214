import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AlignResult, ScoreParams } from "./types.js";

export interface SeqVersionRow {
  id: number;
  name: string;
  version: number;
  seq: string;
  created_at: string;
}

export interface ParamRow {
  id: number;
  name: string;
  version: number;
  payload: ScoreParams | string;
  created_at: string;
}

export interface ReportRow {
  id: number;
  a_seq_version_id: number;
  b_seq_version_id: number;
  score_param_id: number;
  result: AlignResult | string;
  a_seq: string;
  b_seq: string;
  created_at: string;
}

let dbInstance: DatabaseSync | null = null;

export function dbPath(): string {
  return process.env.ALIGN_DB || path.join(process.env.ALIGN_DATA_DIR || "data", "align.sqlite");
}

export function getDb(): DatabaseSync {
  if (dbInstance) return dbInstance;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS seq_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      seq TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS score_params (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_seq_version_id INTEGER NOT NULL REFERENCES seq_versions(id),
      b_seq_version_id INTEGER NOT NULL REFERENCES seq_versions(id),
      score_param_id INTEGER NOT NULL REFERENCES score_params(id),
      a_seq TEXT NOT NULL,
      b_seq TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  dbInstance = db;
  return db;
}

/** 导入（或登记新版本）一条序列；同名同内容复用既有版本，内容变化则 version+1。 */
export function upsertSequence(name: string, seq: string): SeqVersionRow {
  const db = getDb();
  const latest = db.prepare(
    "SELECT * FROM seq_versions WHERE name = ? ORDER BY version DESC LIMIT 1",
  ).get(name) as unknown as SeqVersionRow | undefined;
  if (latest && latest.seq === seq) return latest;
  const version = latest ? latest.version + 1 : 1;
  const info = db.prepare(
    "INSERT INTO seq_versions (name, version, seq) VALUES (?, ?, ?)",
  ).run(name, version, seq);
  return db.prepare("SELECT * FROM seq_versions WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as SeqVersionRow;
}

export function getSequenceVersion(id: number): SeqVersionRow | undefined {
  return getDb().prepare("SELECT * FROM seq_versions WHERE id = ?").get(id) as unknown as SeqVersionRow | undefined;
}

export function listSequenceVersions(name?: string): SeqVersionRow[] {
  const db = getDb();
  return (name
    ? db.prepare("SELECT * FROM seq_versions WHERE name = ? ORDER BY name, version").all(name)
    : db.prepare("SELECT * FROM seq_versions ORDER BY name, version").all()) as unknown as SeqVersionRow[];
}

/** 冻结一套评分参数（含完整自定义矩阵）为带版本的记录。 */
export function saveParams(name: string, payload: ScoreParams): ParamRow {
  const db = getDb();
  const json = JSON.stringify(payload);
  const latest = db.prepare(
    "SELECT * FROM score_params WHERE name = ? ORDER BY version DESC LIMIT 1",
  ).get(name) as unknown as ParamRow | undefined;
  if (latest && JSON.stringify(JSON.parse(latest.payload as string)) === json) return latest;
  const version = latest ? latest.version + 1 : 1;
  const info = db.prepare(
    "INSERT INTO score_params (name, version, payload) VALUES (?, ?, ?)",
  ).run(name, version, json);
  const row = db.prepare("SELECT * FROM score_params WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as ParamRow;
  return { ...row, payload: JSON.parse(row.payload as string) };
}

export function getParams(id: number): (ParamRow & { payload: ScoreParams }) | undefined {
  const row = getDb().prepare("SELECT * FROM score_params WHERE id = ?").get(id) as unknown as ParamRow | undefined;
  if (!row) return undefined;
  return { ...row, payload: JSON.parse(row.payload as string) };
}

export function listParams(): Array<ParamRow & { payload: ScoreParams }> {
  const rows = getDb().prepare("SELECT * FROM score_params ORDER BY name, version").all() as unknown as ParamRow[];
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload as string) }));
}

/** 保存报告时把原始序列与参数结果一并冻结，服务重启后可据此复核。 */
export function saveReport(
  aVersionId: number,
  bVersionId: number,
  paramId: number,
  aSeq: string,
  bSeq: string,
  result: AlignResult,
): number {
  const info = getDb().prepare(
    `INSERT INTO reports (a_seq_version_id, b_seq_version_id, score_param_id, a_seq, b_seq, result)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(aVersionId, bVersionId, paramId, aSeq, bSeq, JSON.stringify(result));
  return Number(info.lastInsertRowid);
}

export function getReport(id: number): (ReportRow & { result: AlignResult }) | undefined {
  const row = getDb().prepare("SELECT * FROM reports WHERE id = ?").get(id) as unknown as ReportRow | undefined;
  if (!row) return undefined;
  return { ...row, result: JSON.parse(row.result as string) };
}

export function listReports(): Array<ReportRow & { result: AlignResult }> {
  const rows = getDb().prepare("SELECT * FROM reports ORDER BY id").all() as unknown as ReportRow[];
  return rows.map((r) => ({ ...r, result: JSON.parse(r.result as string) }));
}
