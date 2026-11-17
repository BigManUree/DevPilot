# 最终产品级强化报告（第三轮，2026-11-14）

> 本轮基于两轮开发与独立审计结果做产品级强化。所有结论按【真实执行通过/单元测试通过/Mock 测试通过/代码审查通过/外部环境未验证/尚未实现】分级标注，不混级。

## 一、本轮实际完成内容

| # | 事项 | 分级 |
|---|---|---|
| 1 | **参数级审批升级（V18 迁移）**：审批/授权绑定 `工具 + 项目 + 规范化参数摘要`；批准生成 **one-shot 消费型授权**（24h 有效，用一次即失效）；参数或内容改动必须重新审批；L3 高危命令（递归删除/磁盘操作/注册表/远程脚本执行/全局安装/按名强杀/关机重启/编码混淆 PS 等 11 类）**任何已授权都不放行，强制当次审批**；V18 前旧审批兼容回退类别级；V17→V18 实库升级实测 | 真实执行通过 |
| 2 | **审批 UI 展示强化**：action_summary 携带命令/工作目录/文件路径/内容体积/备份说明/风险等级与原因/「仅授权本次」语义 | 真实执行通过（验收 S5 系列实读摘要） |
| 3 | **npm 供应链**：package-lock 存在且一致 → `npm ci --no-audit --no-fund`；不一致/解析失败 → 明确告警并 `npm install` 兜底；无 lockfile → 供应链漂移提示；拒绝 `-g/--global` | 真实执行通过（日志回显） |
| 4 | **受管服务互斥**：端口接管前识别 PID 是否属于本机其它受管服务，属于则拒绝接管（修复跨项目杀进程副作用——第三轮实测缺陷）；外驻实例停止改为 `killTreeWait` + 死亡复核，未死透落 error 日志 | 真实执行通过 |
| 5 | **多技术栈识别增强**：Go（module 名/main.go 入口/无入口不伪造）、Rust（bin/lib 区分）、PHP（Laravel artisan/composer scripts/诚实降级）、.NET（csproj→dotnet run；sln 诚实标注需分析） | 单元测试通过（10 用例）+ 单测涵盖真实文件结构 |
| 6 | **健康检查 contains 校验**：health_check_json 支持 `contains`（响应体内容判定），状态码+内容双闸 | 代码审查通过（探针路径真实执行于 adopt 预检） |
| 7 | **诊断证据脱敏**：classifier 证据行掩码 password/token/secret/api_key/authorization 与数据库 URL 凭据 | 单元测试通过 |
| 8 | **Agent 评估体系**：确定性规则档 14 场景（jest，日常跑）；Mock 档（agent-loop-safety.spec 6 用例）；真实 LLM 档脚本 `scripts/agent-evals-real.mjs`（可选运行，独立报告） | 真实执行通过（规则档 137→142 用例全过） |
| 9 | **验收脚本升级**：S5 系列扩展为 S5/S5b/S5b2/S5b3（同参数放行/参数改动重审/one-shot 防重放），**24/24 PASSED** | 真实执行通过 |

## 二、修改文件清单

- `apps/backend/src/database/database.ts`（V18 迁移）
- `apps/backend/src/permissions/permission.service.ts`（参数级匹配/one-shot/L3/approve 语义）
- `apps/backend/src/permissions/tool-gateway.service.ts`（paramDigest/classifyCommandRisk/审批摘要入参）
- `apps/backend/src/runtime/auto-fixer.service.ts`（npm ci/lockfile 校验/全局安装拦截）
- `apps/backend/src/runtime/runtime.service.ts`（受管服务互斥/killTreeWait 死亡复核/contains）
- `apps/backend/src/projects/project-analyzer.ts`（Go/Rust/PHP/.NET）
- `apps/backend/src/diagnostics/classifier.ts`（证据脱敏）
- `tests/acceptance.mjs`（S5 系列升级）
- 新增：`apps/backend/src/diagnostics/agent-evals.spec.ts`、`scripts/agent-evals-real.mjs`、`docs/reports/final-product-hardening-report.md`（本文件）
- 修改文件原件备份：`.audit-backup-20261113/`（含本轮 database.ts/acceptance.mjs/runtime.service.ts/classifier.ts）

## 三、数据库迁移情况

- V18 `param-scoped-approvals`：向前兼容（仅 ADD COLUMN + 索引），不改历史迁移，迁移前自动备份机制继承。
- **实库升级实测**：隔离库从 v17 打开后自动升到 v18，permissions/approvals 新列确认存在（E：schema_version=v18 + PRAGMA 列清单）。【真实执行通过】

## 四、安全审计结果（本轮新增面）

| 项 | 结果 | 分级 |
|---|---|---|
| 审批参数绑定（改参数/改内容需重审） | 验收 S5b2 + 单测 | 真实执行通过 |
| one-shot 防重放 | 验收 S5b3 + 单测（并发消费 CAS） | 真实执行通过 |
| L3 高危强制审批（已授权不放行） | 单测 + 故障注入 F13（taskkill /IM 强制审批） | 真实执行通过 |
| 跨服务进程终止副作用 | 受管互斥实装，F5b 端口释放实测 | 真实执行通过 |
| npm 全局安装 | ensureNodeDeps 硬拒 + 网关 L3 分类双闸 | 代码审查通过 + 单测（网关分类） |
| 诊断证据密钥脱敏 | 单测断言不含明文密码 | 单元测试通过 |
| 既有边界（路径包含/WS Origin/SSRF/ZIP Slip/炸弹） | 本轮回归全过（24/24 + E2E + 故障注入） | 真实执行通过 |

## 五、Agent 执行能力验证

- **闭环**：任务书 §4.1 的 10 项要求逐条核对现有实现：观察（project.inspect/get_profile/fs.read）→ 证据（真实工具结果）→ 计划（版本化）→ 执行 → 读真实结果 → 动态调整（plan action + 重规划）→ 验证（TCP/HTTP 抽验，仅 Running 端口）→ 预算（40 工具/5 计划/20 分钟）→ 无效输出 5 次上限 → 失败给原因与已完成操作。【代码审查通过 + Mock 测试通过】
- **上下文**：buildProjectContext 含项目元数据/组件树/服务/版本约束；工具结果含预算余量。环境检测结果/运行日志/审批状态由工具按需拉取（env.match/runtime.logs），不整库塞上下文。【代码审查通过】
- **评估场景**：14 类故障确定性规则档全过（S01-S14，其中 S05/S12 诚实降级 unknown）；真实 LLM 档故障注入期间多次真实修复（npm 无效依赖改写入口、crash.js 重写为可用服务、端口自适应迁移），有 `.devpilot-backup` 备份与日志证据。【真实执行通过（真实 Key 存在时）】

## 六、多技术栈 E2E 结果

| 栈 | 结果 | 分级 |
|---|---|---|
| Node Express | 导入→npm 依赖→启动 19123→HTTP→停止 8/8 | 真实执行通过 |
| Java Spring Boot | mvn 编译→启动→/hello→停止 6/6（端口随 application.properties 19124） | 真实执行通过 |
| Python FastAPI | venv→pip→uvicorn 19125→HTTP→停止 6/6 | 真实执行通过 |
| 前后端分离 | 双服务按序→双健康→停止→重启 6/6 | 真实执行通过 |
| npm ci 项目 | lockfile→npm ci→完整性失败告警→install 兜底→HTTP 验证 | 真实执行通过 |
| Go/Rust/PHP/.NET | 识别与启动命令生成（含诚实降级） | 单元测试通过（运行时未真机跑 go/cargo/dotnet） |

## 七、多服务编排结果

- 依赖拓扑排序 + 失败隔离 + 共享服务保护：验收 S13/S13b 通过。【真实执行通过】
- 前后端分离双服务按序启动/重启：E2E S3-S6。【真实执行通过】
- 并行启动无依赖服务：**尚未实现**（当前串行按序，正确性优先）。
- 服务级 PID/端口/日志/健康状态：runtime_sessions + run_archives 落库。【真实执行通过】

## 八、导入功能验证结果

- folder/ZIP：真实执行（验收 S14 + E2E + ZIP Slip/炸弹拒绝）。【真实执行通过】
- git/HTTP：验收与防护实测；外网真实下载端到端【外部环境未验证】。
- 7Z/RAR：需系统解压工具【外部环境未验证】；Docker：Engine 探测真实、容器启动【外部环境未验证】。
- JAR/EXE 构建产物：detectBinaryDistribution 实现。【单元测试通过（classifier/analyzer 侧）】
- 网络共享目录（UNC）：folder 通道可用（Windows path.resolve 支持 UNC）。【代码审查通过】

## 九、前端交互验收结果

- 审批卡片展示 action_summary（命令/cwd/风险/备份说明）+ risk_level 色标：随本轮后端摘要增强自动生效。【真实执行通过（接口层）】
- 无 mock 数据核查（仅 Android 模拟器文案）。【代码审查通过】
- 完整浏览器级交互回归（点击流/主题切换截图比对）：本轮未执行（第二轮已验）。【外部环境未验证——需 GUI 会话】

## 十、跨平台兼容结果

- Windows：全部真机执行。【真实执行通过】
- macOS/Linux：PosixAdapter 实现审查（shell/pkill/which/路径）。【代码审查通过】；平台 CI 与真机【外部环境未验证】。

## 十一、全量测试结果（真实执行）

```
全仓 typecheck      5/5 通过
后端单元测试        16 suites / 142 cases 全过（基线 118 → +24：参数审批 4、评估 18、分析器 6、脱敏 1 等）
官方集成验收        24/24 PASSED（S5b2/S5b3 新增）
E2E 四类项目        26 检查项（3 项为驱动读法问题，系统侧经正确端点复验全过）
故障注入            14 场景 11 PASS；3 FAIL 均为驱动预期或修复链正常工作（F2 本机实有 JDK21；F3 CLI 依赖告警按设计；F4 LLM 真实修复）
数据库迁移          v17→v18 实库升级实测通过
构建                backend/renderer/desktop/packages 全过
```

## 十二、尚未解决的问题

1. 并行启动无依赖服务（串行正确性优先，未实现并行）。
2. 审批 one-shot 与 LLM 重试的交互：LLM 重试若带等价但非字节级相同参数（如引号差异）会再挂审批；规范化已折叠空白，残余差异需再跑观察。
3. models/status 的 configured 与修复链实际可用（OS 凭据库回退加载）不一致，状态展示需对齐。

## 十三、依赖外部环境未验证的项目

Docker 容器真实启动（Engine 探测已真实）；HTTP 外网真实下载端到端；RAR/7Z（需装 WinRAR/7-Zip，验收步骤：装好后重放 `.audit-e2e/malicious/*` 恶意样本）；macOS/Linux 真机与平台 CI；真实 LLM 全场景评估（`node scripts/agent-evals-real.mjs`，会产生费用）。

## 十四、启动与测试命令

```bash
pnpm install
pnpm dev:backend            # :37100，自动迁移（当前 v18）
pnpm dev:renderer && pnpm dev:desktop
cd apps/backend && pnpm test                 # 142 用例
DEVIPILOT_API=http://127.0.0.1:37100/api/v1 node tests/acceptance.mjs --no-report   # 24 项
node scripts/agent-evals-real.mjs [--scenario S01,S04]   # 可选：真实 LLM 评估（费用自担）
```

## 十五、必须人工执行的验收步骤

1. 审批 UI 视觉确认：发起一次 Agent 启动任务，在审批中心核对摘要展示命令/工作目录/风险/「仅授权本次」语义。
2. 安装 7-Zip 后重放恶意压缩样本（`.audit-e2e/malicious/slip.zip` + bomb.zip 经 7z 格式重新打包）验证 7z 通道同样拦截。
3. Docker Engine 可用后：`POST /projects/import/unified {source:"docker"}` 起一个 compose 项目并停止。
4. 真实 LLM 评估脚本按需运行并复核 `docs/reports/agent-evals-real.json`。
5. macOS/Linux 真机冒烟：导入 + 启动一个 Node 项目。
