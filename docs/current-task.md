# 当前任务

## 2026-11-14（晚）：UI 修复 + Agent 进程管理能力 — 已完成

用户反馈 4 项：

1. **工作台横向溢出**：`dp-content` 加 `overflow-x: hidden`（应用不出现横向滚动）+ dashboard 网格子项 `min-width:0` + 卡片体 overflow 保护。【CSS 实改，构建通过】
2. **Agent 工作区无法上下滚动**：根因 `dp-agent-main`（grid 子项）缺 `min-height:0`，内容撑破容器被裁剪。已修。【CSS 实改】
3. **Agent 工作区重设计**：时间线竖轴 + 步骤节点圆点、工具名等宽字体、`pre` 代码块化、结果卡按验证结果着色（通过绿/失败红/部分黄）、`[validation=...]` 尾巴拆成结构化徽标、WaitingApproval 顶部醒目横幅（批准/拒绝就地操作）、composer 聚焦高亮 + Ctrl+Enter 发送 + 按钮改「发送并执行」（创建后自动 run）。【代码实改，typecheck+build 通过】
4. **Agent 能补上进程管理**：新增 `process.list`（L0）/`process.kill`（L3）工具。真实 tasklist 列进程（支持 pid/名称过滤）；杀进程走参数级审批（`devpilot-internal:kill-pid:<pid>` 强制 L3 当次审批），批准后 `killTreeWait` 真杀并返回验证证据（进程名/是否死亡/守护重启检测）。系统提示词补充「杀 PID」处理规约（先 list 确认目标→审批→杀→验证）。真实进程 E2E 测试通过（spawn 子进程→挂审批→批准→真杀→确认死亡→one-shot 消费）。修复过程中发现并修正 L3 审批死锁设计缺陷（L3 门必须让位于显式 one-shot 匹配）。

回归：typecheck 5/5、单测 **17 suites / 147 cases** 全过、官方验收 24/24。

## 2026-11-14：最终产品级强化（第三轮）— 已完成

按《最终产品级强化与交付验收任务》执行完毕。核心交付：

1. 参数级审批（V18 迁移）：one-shot 授权、参数绑定、L3 高危强制审批、旧审批兼容迁移。
2. npm 供应链：npm ci 优先 + lockfile 一致性校验 + 全局安装拦截。
3. 受管服务互斥（跨项目杀进程缺陷修复）+ 外驻实例停止死亡复核。
4. 多技术栈识别（Go/Rust/PHP/.NET，诚实降级）。
5. Agent 评估体系（确定性 14 场景 / Mock / 真实 LLM 三档）。
6. 诊断证据脱敏、健康检查 contains 校验。

验收：24/24；单测 142/142；E2E 四类项目 + npm ci 项目通过；故障注入 11/14（3 项为驱动预期）。
详见 `docs/reports/final-product-hardening-report.md`。

## 遗留事项（按优先级）

1. 并行启动无依赖服务。
2. models/status configured 语义与 OS 凭据库回退加载对齐。
3. 外部环境项：Docker 容器启动、RAR/7Z、HTTP 外网下载端到端、macOS/Linux 真机（见报告 §13）。
