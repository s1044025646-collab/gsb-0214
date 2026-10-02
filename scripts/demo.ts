/**
 * 端到端演示：
 *  1. 内部长插入与缺口长度 1/2 罚分
 *  2. 修改开缺口代价如何改变“一个长缺口 vs 多个短缺口”的取舍
 *  3. 篡改操作串被外部核验器识别
 *  4. 模拟服务重启后复核旧报告
 *  5. 非对称矩阵方向性
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "align-demo-"));
process.env.ALIGN_DATA_DIR = tmp;
process.env.ALIGN_DB = path.join(tmp, "demo.sqlite");

const { align } = await import("../src/align.js");
const { defaultParams } = await import("../src/scoring.js");
const { verifyAlignment } = await import("../src/verify.js");
const { solve, recheckReport } = await import("../src/service.js");

function line(t: string) { console.log("\n=== " + t + " ==="); }

line("1. 内部长插入：缺口长度 2 = open+(2-1)*extend");
{
  const r = align("ACDE", "AE", defaultParams());
  console.log("A:", r.alignment!.alignedA);
  console.log("B:", r.alignment!.alignedB);
  console.log("CIGAR:", r.alignment!.cigar, "总分:", r.score, "分项:", r.alignment!.breakdown);
  console.log("坐标 A:", r.alignment!.coords.a, "B:", r.alignment!.coords.b, "未对齐:", r.alignment!.unaligned);
}

line("2a. open 便宜(2)：一个长缺口更划算");
{
  const A = "AAAAACDEFGHIK";
  const B = "AAAAAGHIK";
  const cheap = solve({ aSeq: A, bSeq: B, params: { gapOpen: 2, gapExtend: 1 } });
  console.log("便宜 open=2  分数:", cheap.result!.score, JSON.stringify(cheap.result!.alignment?.breakdown));
  console.log(cheap.result!.alignment?.alignedA);
  console.log(cheap.result!.alignment?.alignedB);

  const expensive = solve({ aSeq: A, bSeq: B, params: { gapOpen: 10, gapExtend: 1 } });
  console.log("昂贵 open=10 分数:", expensive.result!.score, "正分:", expensive.result!.positive);
  if (expensive.result!.alignment) {
    console.log(expensive.result!.alignment.alignedA);
    console.log(expensive.result!.alignment.alignedB);
  } else {
    console.log("-> 开缺口太贵，放弃任何需要缺口的比对");
  }
}

line("3. 篡改操作串被识别");
{
  const r = solve({ aSeq: "ACDEK", bSeq: "ALCDEK", params: {} });
  const al = r.result!.alignment!;
  const tampered = { ...al, ops: al.ops.replace("D", "M") };
  const v = verifyAlignment("ACDEK", "ALCDEK", tampered, r.result!.paramsSnapshot, r.result!.score);
  console.log("合法核验:", recheckReport(r.reportId!).verification!.valid);
  console.log("篡改后核验:", v.valid, "问题:", v.problems);
}

line("4. 模拟服务重启后复核旧报告（只读 SQLite，不重跑 DP）");
{
  const r = solve({ aName: "keepA", bName: "keepB", aSeq: "GHIKLM", bSeq: "GHLKLM", params: {} });
  const id = r.reportId!;
  console.log("报告 ID:", id, "已冻结到", process.env.ALIGN_DB);
  const rc = recheckReport(id);
  console.log("重启后复核:", rc.verification!.valid, "重算分:", rc.verification!.recomputedScore, rc.verification!.note);
}

line("5. 非对称矩阵方向：matrix[A][R]=5 而 matrix[R][A]=-5");
{
  const letters = "ARNDCQEGHILKMFPSTWYV".split("");
  const rows: number[][] = letters.map((x) => letters.map((y) => (x === y ? 2 : -3)));
  rows[letters.indexOf("A")][letters.indexOf("R")] = 5;
  rows[letters.indexOf("R")][letters.indexOf("A")] = -5;
  const params: any = defaultParams();
  params.matrix = {};
  for (const x of letters) { params.matrix[x] = {}; for (const y of letters) params.matrix[x][y] = rows[letters.indexOf(x)][letters.indexOf(y)]; }
  console.log("align(A,R) =", align("A", "R", params).score, " align(R,A) positive =", align("R", "A", params).positive);
}
