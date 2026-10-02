import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AlignmentResult, ScoreMatrix } from "../core/types.js";
import { validateMatrix } from "../core/matrix.js";
import { validateSequence } from "../core/validate.js";

export interface SequenceRow {
  id: number;
  name: string;
  seq: string;
  version: number;
  created_at: string;
}

export interface ScoreSetRow {
  id: number;
  name: string;
  matrix_json: string;
  gap_open: number;
  gap_extend: number;
  version: number;
  created_at: string;
}

export function openDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sequences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      seq TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS scoresets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      matrix_json TEXT NOT NULL,
      gap_open INTEGER NOT NULL,
      gap_extend INTEGER NOT NULL,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(name, version)
    );
    CREATE TABLE IF NOT EXISTS alignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq_a_snapshot TEXT NOT NULL,
      seq_b_snapshot TEXT NOT NULL,
      matrix_json TEXT NOT NULL,
      matrix_name TEXT NOT NULL,
      gap_open INTEGER NOT NULL,
      gap_extend INTEGER NOT NULL,
      score INTEGER,
      a_start INTEGER, a_end INTEGER, b_start INTEGER, b_end INTEGER,
      aligned_a TEXT, aligned_b TEXT, cigar TEXT,
      pre_a TEXT, suf_a TEXT, pre_b TEXT, suf_b TEXT,
      no_positive INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function addSequence(db: DatabaseSync, name: string, seq: string): SequenceRow {
  const v = validateSequence(seq);
  if (!v.ok) throw new Error("序列非法：\n" + v.errors.join("\n"));
  const last = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM sequences WHERE name = ?")
    .get(name) as { v: number };
  const version = last.v + 1;
  const info = db
    .prepare("INSERT INTO sequences(name, seq, version) VALUES (?, ?, ?)")
    .run(name, v.normalized, version);
  return getSequence(db, Number(info.lastInsertRowid)) as SequenceRow;
}

export function getSequence(db: DatabaseSync, id: number): SequenceRow | undefined {
  return db.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as SequenceRow | undefined;
}

export function getSequenceVersion(db: DatabaseSync, name: string, version?: number): SequenceRow | undefined {
  if (version === undefined) {
    return db.prepare("SELECT * FROM sequences WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as
      | SequenceRow
      | undefined;
  }
  return db.prepare("SELECT * FROM sequences WHERE name = ? AND version = ?").get(name, version) as
    | SequenceRow
    | undefined;
}

export function listSequences(db: DatabaseSync): SequenceRow[] {
  return db.prepare("SELECT * FROM sequences ORDER BY name, version").all() as unknown as SequenceRow[];
}

export function addScoreSet(
  db: DatabaseSync,
  name: string,
  matrix: ScoreMatrix,
  gapOpen: number,
  gapExtend: number,
): ScoreSetRow {
  const errors = validateMatrix(matrix);
  if (errors.length > 0) throw new Error("评分矩阵非法：\n" + errors.join("\n"));
  const last = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM scoresets WHERE name = ?")
    .get(name) as { v: number };
  const version = last.v + 1;
  const info = db
    .prepare(
      "INSERT INTO scoresets(name, matrix_json, gap_open, gap_extend, version) VALUES (?, ?, ?, ?, ?)",
    )
    .run(name, JSON.stringify(matrix), gapOpen, gapExtend, version);
  return getScoreSet(db, Number(info.lastInsertRowid)) as ScoreSetRow;
}

export function getScoreSet(db: DatabaseSync, id: number): ScoreSetRow | undefined {
  return db.prepare("SELECT * FROM scoresets WHERE id = ?").get(id) as ScoreSetRow | undefined;
}

export function getScoreSetVersion(db: DatabaseSync, name: string, version?: number): ScoreSetRow | undefined {
  if (version === undefined) {
    return db.prepare("SELECT * FROM scoresets WHERE name = ? ORDER BY version DESC LIMIT 1").get(name) as
      | ScoreSetRow
      | undefined;
  }
  return db.prepare("SELECT * FROM scoresets WHERE name = ? AND version = ?").get(name, version) as
    | ScoreSetRow
    | undefined;
}

export function listScoreSets(db: DatabaseSync): ScoreSetRow[] {
  return db.prepare("SELECT * FROM scoresets ORDER BY name, version").all() as unknown as ScoreSetRow[];
}

export function parseScoreSet(row: ScoreSetRow): { matrix: ScoreMatrix; gapOpen: number; gapExtend: number } {
  return {
    matrix: JSON.parse(row.matrix_json) as ScoreMatrix,
    gapOpen: row.gap_open,
    gapExtend: row.gap_extend,
  };
}

export interface StoredAlignment {
  id: number;
  created_at: string;
  result: AlignmentResult | null;
  noPositive: boolean;
  snapshots: { seqA: string; seqB: string; gapOpen: number; gapExtend: number; matrix: ScoreMatrix };
}

export function saveAlignment(
  db: DatabaseSync,
  seqA: string,
  seqB: string,
  matrix: ScoreMatrix,
  gapOpen: number,
  gapExtend: number,
  result: AlignmentResult | null,
): number {
  const info = db
    .prepare(
      `INSERT INTO alignments(
        seq_a_snapshot, seq_b_snapshot, matrix_json, matrix_name,
        gap_open, gap_extend, score,
        a_start, a_end, b_start, b_end, aligned_a, aligned_b, cigar,
        pre_a, suf_a, pre_b, suf_b, no_positive
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      seqA,
      seqB,
      JSON.stringify(matrix),
      matrix.name,
      gapOpen,
      gapExtend,
      result?.score ?? null,
      result?.aStart ?? null,
      result?.aEnd ?? null,
      result?.bStart ?? null,
      result?.bEnd ?? null,
      result?.alignedA ?? null,
      result?.alignedB ?? null,
      result?.cigar ?? null,
      result?.unalignedPrefixA ?? null,
      result?.unalignedSuffixA ?? null,
      result?.unalignedPrefixB ?? null,
      result?.unalignedSuffixB ?? null,
      result === null ? 1 : 0,
    );
  return Number(info.lastInsertRowid);
}

export function getAlignment(db: DatabaseSync, id: number): StoredAlignment | undefined {
  const row = db.prepare("SELECT * FROM alignments WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  const matrix = JSON.parse(row.matrix_json as string) as ScoreMatrix;
  const noPositive = Number(row.no_positive) === 1;
  let result: AlignmentResult | null = null;
  if (!noPositive) {
    result = {
      seqA: row.seq_a_snapshot as string,
      seqB: row.seq_b_snapshot as string,
      scoreMatrixName: row.matrix_name as string,
      gapOpen: Number(row.gap_open),
      gapExtend: Number(row.gap_extend),
      score: Number(row.score),
      aStart: Number(row.a_start),
      aEnd: Number(row.a_end),
      bStart: Number(row.b_start),
      bEnd: Number(row.b_end),
      alignedA: row.aligned_a as string,
      alignedB: row.aligned_b as string,
      cigar: row.cigar as string,
      unalignedPrefixA: row.pre_a as string,
      unalignedSuffixA: row.suf_a as string,
      unalignedPrefixB: row.pre_b as string,
      unalignedSuffixB: row.suf_b as string,
    };
  }
  return {
    id: Number(row.id),
    created_at: row.created_at as string,
    result,
    noPositive,
    snapshots: {
      seqA: row.seq_a_snapshot as string,
      seqB: row.seq_b_snapshot as string,
      gapOpen: Number(row.gap_open),
      gapExtend: Number(row.gap_extend),
      matrix,
    },
  };
}

export function exportDbJson(db: DatabaseSync): unknown {
  return {
    sequences: listSequences(db),
    scoresets: listScoreSets(db),
    alignments: db.prepare("SELECT * FROM alignments ORDER BY id").all(),
  };
}
