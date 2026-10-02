import test from "node:test";
import assert from "node:assert/strict";
import { validateSequence, validateGapParams } from "../core/validate.js";

test("空序列：明确的错误结果", () => {
  const v = validateSequence("");
  assert.equal(v.ok, false);
  assert.ok((v.errors[0] ?? "").includes("为空"));
});

test("非法字符（B/Z/X/*/数字/空格/中文）被逐位指出", () => {
  for (const bad of ["B", "Z", "X", "*", "1", " ", "甲", "ARN-"]) {
    const v = validateSequence(bad);
    assert.equal(v.ok, false, `应拒绝: ${bad}`);
  }
});

test("二十种标准氨基酸全部接受，小写自动归一为大写", () => {
  const letters = "ARNDCQEGHILKMFPSTWYV";
  const v = validateSequence(letters.toLowerCase());
  assert.equal(v.ok, true);
  assert.equal(v.normalized, letters);
});

test("非字符串输入", () => {
  assert.equal(validateSequence(null).ok, false);
  assert.equal(validateSequence(undefined as unknown as string).ok, false);
  assert.equal(validateSequence(123 as unknown as string).ok, false);
});

test("缺口参数：两个成本必须都为正整数", () => {
  assert.ok("open" in validateGapParams(5, 1));
  for (const [o, e] of [[0, 1], [-1, 1], [1, 0], [1.5, 1], [1, NaN], [1, Infinity]] as [number, number][]) {
    assert.ok("error" in validateGapParams(o, e), `应拒绝 open=${o} extend=${e}`);
  }
});
