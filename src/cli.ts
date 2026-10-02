#!/usr/bin/env node
import * as db from "./db.js";
import { solve, recheckReport, diffParams } from "./service.js";
import { verifyAlignment } from "./verify.js";
import { defaultParams, normalizeMatrix, validateParams } from "./scoring.js";
import { cleanSequence } from "./validate.js";
import fs from "node:fs";

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function fail(errors: string[]): never {
  console.error(JSON.stringify({ errors }, null, 2));
  process.exit(1);
}

function readJsonArg(value: string | undefined, file: string | undefined): unknown {
  if (file) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (value) return JSON.parse(value);
  return undefined;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];

  switch (cmd) {
    case "import-seq": {
      const c = cleanSequence(flags.seq, flags.name);
      if (!c.ok) fail(c.errors);
      out(db.upsertSequence(flags.name, c.seq));
      return;
    }
    case "list-seq": {
      out(db.listSequenceVersions(flags.name));
      return;
    }
    case "import-params": {
      const parsed = readJsonArg(flags.json, flags.file) as any;
      if (!parsed || !parsed.name) fail(["需要 --json '{\"name\":...,\"params\":...}' 或 --file"]);
      const base = defaultParams();
      const body = parsed.params || parsed;
      const params: any = {
        match: body.match ?? base.match,
        mismatch: body.mismatch ?? base.mismatch,
        gapOpen: body.gapOpen ?? base.gapOpen,
        gapExtend: body.gapExtend ?? base.gapExtend,
      };
      if (body.matrix !== undefined) {
        const { matrix, errors } = normalizeMatrix(body.matrix);
        if (errors.length) fail(errors);
        params.matrix = matrix;
      }
      const errs = validateParams(params);
      if (errs.length) fail(errs);
      out(db.saveParams(parsed.name, params));
      return;
    }
    case "list-params": {
      out(db.listParams());
      return;
    }
    case "align": {
      const payload = readJsonArg(flags.json, flags.file) as any;
      if (!payload) fail(["需要 --json 或 --file 提供求解输入"]);
      const r = solve(payload);
      if (r.errors) fail(r.errors);
      out({ reportId: r.reportId, result: r.result, verification: r.verification });
      return;
    }
    case "report": {
      const row = db.getReport(Number(flags.id));
      if (!row) fail([`报告 ${flags.id} 不存在`]);
      out(row);
      return;
    }
    case "verify": {
      if (flags.id) {
        out(recheckReport(Number(flags.id)));
        return;
      }
      const payload = readJsonArg(flags.json, flags.file) as any;
      if (!payload) fail(["需要 --id 或 --json/--file"]);
      out({ verification: verifyAlignment(payload.aSeq, payload.bSeq, payload.alignment, payload.params, payload.score) });
      return;
    }
    case "diff-params": {
      const r = diffParams(Number(flags.id1), Number(flags.id2));
      if (r.errors) fail(r.errors);
      out(r.diff);
      return;
    }
    case "export": {
      out({
        sequences: db.listSequenceVersions(),
        params: db.listParams(),
        reports: db.listReports(),
      });
      return;
    }
    default: {
      console.log([
        "用法: npm run cli -- <命令> [参数]",
        "命令:",
        "  import-seq --name <名> --seq <序列>",
        "  list-seq [--name <名>]",
        "  import-params --file <params.json>   (或 --json '<JSON>')",
        "  list-params",
        "  align --file <solve.json>            (或 --json)",
        "  report --id <报告ID>",
        "  verify --id <报告ID> | --file <evidence.json>",
        "  diff-params --id1 <n> --id2 <n>",
        "  export",
      ].join("\n"));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
