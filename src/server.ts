import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { openDb, exportDbJson } from "./db/db.js";
import {
  addScoreSet,
  addSequence,
  compareStored,
  getAlignment,
  listScoreSets,
  listSequences,
  solve,
  verifyStored,
} from "./service.js";
import { blosum62, defaultMatrix } from "./core/matrix.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? resolve(DATA_DIR, "align.sqlite");

const db = openDb(DB_PATH);

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => unknown | Promise<unknown>;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/health$/,
    handle: (_req, res) => send(res, 200, { ok: true, db: DB_PATH }),
  },
  {
    method: "POST",
    pattern: /^\/api\/sequences$/,
    handle: (_req, res, _p, body) => {
      if (typeof body.name !== "string" || typeof body.seq !== "string") {
        return send(res, 400, { error: "需要 name 与 seq 字段" });
      }
      const row = addSequence(db, body.name, body.seq);
      send(res, 201, row);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/sequences$/,
    handle: (_req, res) => send(res, 200, listSequences(db)),
  },
  {
    method: "GET",
    pattern: /^\/api\/sequences\/([^/]+)$/,
    handle: (_req, res, p) => send(res, 200, listSequences(db).filter((r) => r.name === decodeURIComponent(p[0] as string))),
  },
  {
    method: "POST",
    pattern: /^\/api\/scoresets$/,
    handle: (_req, res, _p, body) => {
      if (typeof body.name !== "string") return send(res, 400, { error: "需要 name" });
      let matrix;
      if (body.preset === "BLOSUM62") matrix = blosum62();
      else if (body.matrix) matrix = body.matrix;
      else matrix = defaultMatrix();
      const row = addScoreSet(db, body.name, matrix, Number(body.gapOpen ?? 5), Number(body.gapExtend ?? 1));
      send(res, 201, { ...row, matrix_json: JSON.parse(row.matrix_json) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/scoresets$/,
    handle: (_req, res) =>
      send(
        res,
        200,
        listScoreSets(db).map((r) => ({ ...r, matrix_json: JSON.parse(r.matrix_json) })),
      ),
  },
  {
    method: "POST",
    pattern: /^\/api\/alignments$/,
    handle: (_req, res, _p, body) => {
      try {
        const out = solve(db, body);
        send(res, 201, {
          id: out.id,
          noPositive: out.result === null,
          result: out.result ?? { note: "最高分为 0：不存在正分局部比对" },
          frozen: { gapOpen: out.snapshots.gapOpen, gapExtend: out.snapshots.gapExtend, matrixName: out.snapshots.matrix.name },
        });
      } catch (err) {
        const e = err as Error;
        const status = e.name === "BudgetExceededError" ? 422 : 400;
        send(res, status, { error: e.message });
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/alignments\/(\d+)$/,
    handle: (_req, res, p) => {
      const stored = getAlignment(db, Number(p[0]));
      if (!stored) return send(res, 404, { error: "报告不存在" });
      send(res, 200, {
        id: stored.id,
        created_at: stored.created_at,
        noPositive: stored.noPositive,
        result: stored.result,
        frozenInput: { seqA: stored.snapshots.seqA, seqB: stored.snapshots.seqB },
        frozenRules: {
          gapOpen: stored.snapshots.gapOpen,
          gapExtend: stored.snapshots.gapExtend,
          matrixName: stored.snapshots.matrix.name,
        },
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/alignments\/(\d+)\/verify$/,
    handle: (_req, res, p, body) => {
      try {
        send(res, 200, verifyStored(db, Number(p[0]), body?.tamperedCigar));
      } catch (e) {
        send(res, 404, { error: (e as Error).message });
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/alignments\/compare$/,
    handle: (_req, res, _p, body) => {
      try {
        send(res, 200, compareStored(db, Number(body.id1), Number(body.id2)));
      } catch (e) {
        send(res, 400, { error: (e as Error).message });
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/export$/,
    handle: (_req, res) => send(res, 200, exportDbJson(db)),
  },
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url as string, `http://${req.headers.host}`);
  let body: any = {};
  if (req.method === "POST") {
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: "请求体不是合法 JSON" });
    }
  }
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = url.pathname.match(r.pattern);
    if (m) {
      await r.handle(req, res, m.slice(1), body);
      return;
    }
  }
  send(res, 404, { error: `无此路由：${req.method} ${url.pathname}` });
});

server.listen(PORT, () => {
  console.log(`蛋白质局部比对服务已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`SQLite: ${DB_PATH}`);
});
