#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openDb, exportDbJson } from "./db/db.js";
import {
  addScoreSet,
  addSequence,
  compareStored,
  getAlignment,
  solve,
  verifyStored,
} from "./service.js";
import { defaultMatrix } from "./core/matrix.js";
import type { ScoreMatrix } from "./core/types.js";

const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "align.sqlite");
mkdirSync(DATA_DIR, { recursive: true });

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[a.slice(2)] = next;
        i++;
      } else {
        out[a.slice(2)] = "true";
      }
    }
  }
  return out;
}

function print(obj: unknown) {
  console.log(JSON.stringify(obj, null, 2));
}

function loadMatrixFile(path?: string): ScoreMatrix | undefined {
  if (!path) return undefined;
  return JSON.parse(readFileSync(resolve(path), "utf8")) as ScoreMatrix;
}

function printAlignment(id: number, stored: NonNullable<ReturnType<typeof getAlignment>>) {
  if (stored.noPositive || !stored.result) {
    console.log(`[报告 #${id}] 最高分为 0：不存在正分局部比对（合法结果，非错误）`);
    return;
  }
  const r = stored.result;
  console.log(`[报告 #${id}] 总分=${r.score}  矩阵=${r.scoreMatrixName}  open=${r.gapOpen} extend=${r.gapExtend}`);
  console.log(`  A[${r.aStart},${r.aEnd})  B[${r.bStart},${r.bEnd})  CIGAR=${r.cigar}`);
  console.log(`  A: ${r.unalignedPrefixA}|${r.alignedA}|${r.unalignedSuffixA}`);
  console.log(`  B: ${r.unalignedPrefixB}|${r.alignedB}|${r.unalignedSuffixB}`);
  console.log(`  (| 外为未对齐残基，不计入内部缺口罚分)`);
}

const db = openDb(DB_PATH);
const cmd = process.argv[2];

try {
  switch (cmd) {
    case "seq-add": {
      const a = args();
      print(addSequence(db, a.name as string, a.seq as string));
      break;
    }
    case "seq-list": {
      print(db.prepare("SELECT id,name,version,seq FROM sequences ORDER BY name,version").all());
      break;
    }
    case "scoreset-add": {
      const a = args();
      const matrix = loadMatrixFile(a.matrix) ?? defaultMatrix();
      print(addScoreSet(db, a.name as string, matrix, Number(a.open ?? 5), Number(a.extend ?? 1)));
      break;
    }
    case "align": {
      const a = args();
      const out = solve(db, {
        seqARaw: a.a,
        seqBRaw: a.b,
        seqAName: a.aname,
        seqBName: a.bname,
        seqAVersion: a.aversion !== undefined ? Number(a.aversion) : undefined,
        seqBVersion: a.bversion !== undefined ? Number(a.bversion) : undefined,
        scoreSetName: a.scoreset,
        matrix: loadMatrixFile(a.matrix),
        preset: a.preset,
        gapOpen: a.open !== undefined ? Number(a.open) : undefined,
        gapExtend: a.extend !== undefined ? Number(a.extend) : undefined,
      });
      const stored = getAlignment(db, out.id)!;
      printAlignment(out.id, stored);
      break;
    }
    case "get": {
      const stored = getAlignment(db, Number(args().id));
      if (!stored) throw new Error("报告不存在");
      printAlignment(stored.id, stored);
      print({ result: stored.result, noPositive: stored.noPositive, created_at: stored.created_at });
      break;
    }
    case "verify": {
      const a = args();
      print(verifyStored(db, Number(a.id), a.cigar));
      break;
    }
    case "compare": {
      const a = args();
      print(compareStored(db, Number(a.id1), Number(a.id2)));
      break;
    }
    case "export": {
      const a = args();
      const json = JSON.stringify(exportDbJson(db), null, 2);
      if (a.out) {
        writeFileSync(resolve(a.out), json, "utf8");
        console.log(`已导出到 ${a.out}`);
      } else {
        console.log(json);
      }
      break;
    }
    case "demo": {
      await runDemo();
      break;
    }
    default:
      console.log(`用法: protalign <命令> [参数]
  seq-add --name N --seq S            导入序列（同名自动升版本）
  seq-list                            列出序列版本
  scoreset-add --name N [--matrix f.json] [--open 5] [--extend 1]
                                      导入评分矩阵（缺省 match+2/mismatch-1）
  align --a SEQ --b SEQ [--preset default|BLOSUM62] [--open 5] [--extend 1]
                                      直接比对两条序列
  align --aname N1 --bname N2 [--scoreset S] [--open ..] [--extend ..]
                                      用库中序列（可带版本，见 README）比对
  get --id ID                         回溯摘要
  verify --id ID [--cigar X]          外部核验（可选传入被篡改 CIGAR）
  compare --id1 X --id2 Y             参数版本/得分比较
  export [--out f.json]               JSON 导出
  demo                                运行内置演示场景
环境变量: PORT, DATA_DIR, DB_PATH`);
  }
} catch (err) {
  console.error("错误: " + (err as Error).message);
  process.exitCode = 1;
}

async function runDemo() {
  console.log("=== 演示 1：开缺口代价改变 长缺口 vs 多个短缺口 的取舍 ===");
  // 低 open 时倾向“多个短缺口”，高 open 时倾向“一个长缺口”（见报告对比）
  const s1 = "MKLMPKMKLM";
  const s2 = "MKLMWWWPKMKLM";
  for (const open of [1, 8]) {
    const out = solve(db, { seqARaw: s1, seqBRaw: s2, gapOpen: open, gapExtend: 1 });
    const stored = getAlignment(db, out.id)!;
    printAlignment(out.id, stored);
  }

  console.log("\n=== 演示 2：内部长插入（局部前后杂段被标为未对齐）===");
  const t1 = solve(db, { seqARaw: "WWMKWAPRSKLMWW", seqBRaw: "QQMKWAPRSKLMQQ" });
  printAlignment(t1.id, getAlignment(db, t1.id)!);

  console.log("\n=== 演示 3：无正分比对 ===");
  const t2 = solve(db, { seqARaw: "AAA", seqBRaw: "RRR" });
  printAlignment(t2.id, getAlignment(db, t2.id)!);

  console.log("\n=== 演示 4：识别篡改的 CIGAR 操作串 ===");
  const t3 = solve(db, { seqARaw: "MKLMPKMKLM", seqBRaw: "MKLMWWKMKLM", gapOpen: 2, gapExtend: 1 });
  printAlignment(t3.id, getAlignment(db, t3.id)!);
  const real = getAlignment(db, t3.id)!.result!;
  // 篡改：把真实 CIGAR 的操作类型改一个
  const tampered = real.cigar.replace(/D/, "I");
  console.log(`原始 CIGAR: ${real.cigar}`);
  console.log(`篡改 CIGAR: ${tampered}`);
  const vr = verifyStored(db, t3.id, tampered);
  print(vr);
  console.log("对未篡改报告自身核验：");
  print(verifyStored(db, t3.id));

  console.log("\n=== 演示 5：参数版本比较（open=1 vs open=8 报告）===");
  const ids = db.prepare("SELECT id FROM alignments ORDER BY id LIMIT 2").all() as { id: number }[];
  print(compareStored(db, ids[0]!.id, ids[1]!.id));

  console.log(`\n所有数据已冻结在 SQLite: ${DB_PATH}`);
  console.log("重启后可用 `node dist/cli.js verify --id <ID>` 复核任意旧报告。");
}
