# 蛋白质双序列局部比对与仿射缺口核验后端

离线运行的两条蛋白质序列 **Smith–Waterman 局部比对** 服务，带 **Gotoh 仿射缺口**
模型、独立外部核验器、评分/序列版本管理与 JSON 导出。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22.5，本仓库在 Node v25 上开发验证）
- 存储：SQLite，使用 Node 内置模块 `node:sqlite`，**无需安装任何原生依赖、无需 Docker/WSL**
- 形态：仅 HTTP API 与 CLI，无前端
- 完全离线，不访问任何在线序列库；不做物种树、读段组装或肽段质量检索

## 1. 评分模型（公开定义）

- 序列只接受 **二十种标准氨基酸字母** `A R N D C Q E G H I L K M F P S T W Y V`
  （大小写不敏感，内部统一大写）。`B/Z/X/*/空白` 等一律拒绝。
- 默认替换分：**匹配 `+2`，错配 `-1`**。可整体自定义任意方阵（含非对称矩阵）。
  另内置可选的对称预置 `BLOSUM62`。
- 默认缺口参数：**open=5，extend=1**，两者都必须是 **正整数**。
  长度为 `L` 的连续缺口代价固定为

  ```
  gapCost(L) = open + (L - 1) * extend
  ```

  即缺口长 1 仅付 `open`，每延长一列再付 `extend`。
- **非对称矩阵严格按输入方向使用**：`matrix[a][b]` 表示序列 A 的残基 `a`
  对序列 B 的残基 `b`，程序不做任何转置或对称化。

### Gotoh 三状态 DP

对前缀 `A[1..i]`、`B[1..j]`：

- `H[i][j]`：以匹配/错配列结尾（局部比对状态，截断下界为 0）
- `X[i][j]`：以“消费 A、B 为 `-`”的缺口列结尾
- `Y[i][j]`：以“消费 B、A 为 `-`”的缺口列结尾

转移区分**新开缺口**（付 `open`）与**在已有缺口上延长**（付 `extend`），
不是每字符固定罚分。回溯指针记录每个单元的来源，与打分矩阵一一对应。

## 2. 输出规则

- 只返回 **一个**最高分局部比对。并列最高分时，按**行优先扫描**（先 i 后 j）
  取最早到达最高分的单元，结果确定可复现；不枚举全部最优解。
- **最高分为 0 时返回显式“无正分比对”**，绝不强行匹配全序列。
- 报告内容：
  - `score`：总分
  - `aStart/aEnd`、`bStart/bEnd`：原序列上的 **零起始、半开区间 `[start,end)`**
  - `alignedA/alignedB`：等长带缺口对齐串（`-` 为缺口）
  - `cigar`：CIGAR 式操作串，仅产生 `M/I/D`
    - `M`：同时消费 A、B 各一个残基
    - `I`：只消费 A（B 上是缺口）
    - `D`：只消费 B（A 上是缺口）
  - `unalignedPrefix*/unalignedSuffix*`：局部比对两端未使用残基，单独标注，
    **不计入内部缺口罚分**（对齐串首尾也不允许是缺口列）。

## 3. 外部核验器

`src/core/verify.ts` 是**独立**核验器，不读取任何 DP 矩阵，只根据
原序列 + 半开坐标 + 带缺口对齐串 + CIGAR：

- 逐列重算替换分；把连续的同序列缺口游程按 `open+(L-1)*extend` 重算
- 校验 CIGAR 与每列 `残基/缺口` 是否一致、各操作消费哪条序列
- 校验半开坐标跨度与对齐实际消费残基数一致、残基内容与原序列一致
- 校验首尾无缺口列、未对齐前后缀与原序列一致、声明总分等于重算总分

> 核验通过只说明该方案的**证据合法**；只有完整动态规划（或等价穷举）
> 才能证明它是**最高分**。测试中对很短序列使用穷举器 `bruteForce.ts`
> 枚举所有合法局部比对路径来交叉验证最优分数。

## 4. 预算（超限不输出假定最优结果）

默认公开预算（`src/core/align.ts` 的 `DEFAULT_BUDGET`）：

- `maxLength = 5000`：单条序列最大长度
- `maxCells = 10_000_000`：DP 网格单元数 `(lenA+1)*(lenB+1)` 上限

超限时抛出 `BudgetExceededError`（API 返回 `422`），**不返回**任何可能次优的结果。

## 5. SQLite 冻结语义

- `sequences`：序列按 `(name, version)` 版本化，同名导入自动升版本，旧版本保留。
- `scoresets`：评分矩阵 JSON + 缺口参数同样版本化。
- `alignments`：每次求解把**当时的两条序列快照、矩阵 JSON、open/extend**
  原样写入报告行。之后即使发布新评分版本，旧报告的分数与证据也不会改变，
  可在服务重启后随时重新核验。

数据库默认位于项目内 `data/align.sqlite`（可用环境变量改）。

## 6. 构建 / 测试 / 启动

需要 Node.js ≥ 22.5（内置 `node:sqlite`）。Windows 本地 PowerShell：

```powershell
npm install        # 仅安装 typescript / 类型声明，无运行时第三方依赖
npm run build      # tsc 编译到 dist/
npm test           # 编译并运行 node:test 全部测试（含真实 HTTP 起停测试）
npm run demo       # 运行内置演示场景
npm start          # 启动 HTTP API（默认 http://localhost:3000）
```

可配置环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `DATA_DIR` | `./data` | 项目内数据目录 |
| `DB_PATH` | `$DATA_DIR/align.sqlite` | SQLite 文件完整路径 |

## 7. CLI 用法

编译后可 `node dist/cli.js <命令>`，或 `npm link` 后使用 `protalign`。

```powershell
# 导入 / 列出序列（同名自动升版本）
node dist/cli.js seq-add --name prot1 --seq MKLMPK
node dist/cli.js seq-list

# 导入评分（缺省 match+2/mismatch-1；可用完整矩阵 JSON）
node dist/cli.js scoreset-add --name rules --open 5 --extend 1
node dist/cli.js scoreset-add --name asym --matrix examples/asym2x2.json --open 2 --extend 1

# 直接比对
node dist/cli.js align --a MKLPRST --b MKLPWWWRST --open 2 --extend 1
node dist/cli.js align --a A --b R --matrix examples/asym2x2.json
node dist/cli.js align --aname prot1 --bname prot2 --scoreset rules

# 回溯摘要 / 外部核验 / 参数版本比较 / JSON 导出
node dist/cli.js get --id 1
node dist/cli.js verify --id 1
node dist/cli.js verify --id 1 --cigar 4M3I3M     # 传入可疑（被篡改）CIGAR
node dist/cli.js compare --id1 1 --id2 2
node dist/cli.js export --out report.json
```

## 8. HTTP API

所有请求/响应均为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查与数据库路径 |
| POST | `/api/sequences` | `{name, seq}` 导入序列（升版本） |
| GET | `/api/sequences` | 列出全部序列版本 |
| GET | `/api/sequences/:name` | 按名字列出全部版本 |
| POST | `/api/scoresets` | `{name, matrix?, preset?, gapOpen?, gapExtend?}` |
| GET | `/api/scoresets` | 列出评分集版本 |
| POST | `/api/alignments` | 求解（字段见下） |
| GET | `/api/alignments/:id` | 报告回溯摘要 + 冻结的输入/规则 |
| POST | `/api/alignments/:id/verify` | 外部核验，可传 `{tamperedCigar}` |
| POST | `/api/alignments/compare` | `{id1, id2}` 参数版本/得分比较 |
| GET | `/api/export` | 导出全部表为 JSON |

`POST /api/alignments` 请求字段（均可组合）：

```json
{
  "seqARaw": "MKLPRST",
  "seqBRaw": "MKLPWWWRST",
  "seqAName": "prot1", "seqAVersion": 1,
  "seqBName": "prot2", "seqBVersion": 1,
  "matrix": { "name": "custom", "alphabet": ["A","R"], "matrix": [[2,5],[-5,2]] },
  "preset": "default",
  "scoreSetName": "rules", "scoreSetVersion": 1,
  "gapOpen": 2,
  "gapExtend": 1
}
```

快速尝试：

```powershell
Invoke-RestMethod -Method Post http://localhost:3000/api/alignments `
  -ContentType 'application/json' `
  -Body '{"seqARaw":"MKLPRST","seqBRaw":"MKLPWWWRST","gapOpen":2,"gapExtend":1}'
```

## 9. 演示场景（`npm run demo`）

1. 同一对序列分别用 `open=1` 与 `open=8`：低 open 选择跨一条长缺口的长比对，
   高 open 放弃缺口、只保留右侧无缺口核心，直观展示开缺口代价对
   “一条长缺口 vs 多个/零个短缺口”取舍的影响。
2. 内部长插入 + 局部前后杂段：两端杂段作为未对齐残基单独标注。
3. 无正分输入：输出显式无正分结果。
4. 把真实 CIGAR 的 `D` 篡改为 `I`：外部核验器逐列捕获矛盾并判 `valid=false`。
5. 两个参数版本报告的得分比较。

演示数据写入默认 `data/align.sqlite`；重启后可对任意旧 ID 再次
`node dist/cli.js verify --id <ID>` 复核。

## 10. 测试覆盖

`src/test/` 中 26 个用例覆盖：完全相同、无正分、内部长插入、局部前后杂段、
多个并列最高分的确定性选择、非对称矩阵方向性、对称矩阵交换序列后最优分不变、
缺口长度 1 与 2 的罚分差、对齐串逐列重新计分、篡改 CIGAR/分数识别、
短序列（含 60 组随机短例）穷举路径核对 DP 最优分、预算超限拒绝、
空序列与非法字符、版本冻结、**关闭并重新打开数据库后复核旧报告**、
以及真实起停的 HTTP API 端到端流程。

## 11. 合理假设与限制

- 仅接受二十种标准氨基酸，不支持歧义字母与简并符号。
- 得分与缺口成本使用整数；输入小数会被拒绝。
- 每个请求返回一个确定性选出的最高分比对，不枚举全部并列最优。
- 仅处理两条序列的成对局部比对，不做多序列比对、全局/半全局比对或在线检索。
- `node:sqlite` 在当前 Node 版本会打印一条 experimental 警告，功能正常。
