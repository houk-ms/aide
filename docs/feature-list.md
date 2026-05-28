# Aide Feature List and Implementation Audit

本文基于 PRODUCT.md 与 docs/ 下的产品设计文档，先拆出完整功能清单，再逐项对照当前代码实现进行核对。重点不只看代码是否存在，还看用户路径、交互闭环、错误状态、确认逻辑、信息可见性是否足够让真实用户完成工作。

## 审计结论

当前实现处于“产品骨架已成型，但核心工作路径尚未可用”的阶段。

- App Shell、左侧任务列表、右侧 Chat、Settings Drawer、SQLite schema、基础 CRUD 已经有雏形。
- Task / Project / Relation / Memory / Jobs / Connections 都有数据模型或 UI 入口，但大量路径只是浅连通。
- 最核心的承诺“自动从工作系统收集信息、用 Agent 理解并处理任务、持续记忆、主动 briefing、生成日报”当前已经不再被 TypeScript/build 阻断，但仍受 MCP/Connection 未验证、Job 无头执行缺少可观测性、Agent 写操作确认链路不完整等问题限制。
- 从用户体验角度，最大风险不是某个按钮缺失，而是用户打开后不知道该怎么完成初始配置、看不到外部数据是否真的被拉取、Agent 写操作确认缺少可审查细节、任务状态不会自然流转，最终容易变成一个手工 todo + 空 chat。

状态标记：

- [DONE] 主路径基本存在，可被用户直接使用。
- [PARTIAL] 有入口或局部实现，但路径不完整。
- [SKELETON] 只有模型、接口或占位骨架。
- [MISSING] 产品承诺中存在，代码里没有可用路径。
- [BLOCKED] 理论上实现了，但当前构建/运行会阻断验证或使用。

## 最高优先级问题

### P0-1: 构建已恢复，但 Agent 主链路仍缺少运行时验收

结论：类型检查和 production build 均已通过，不再需要把 Agent/Chat/Job 标记为“构建阻断”。但这只证明代码能编译和打包，还不能证明 Copilot SDK session、MCP server、OAuth token、Job 无头 session 在真实运行时可用。下一步需要 runtime smoke test 和用户可见的 health 状态。

### P0-2: 产品最核心的“自动收集并维护任务”还没有真实闭环

文档要求 Job 定时从 Work IQ / GitHub 拉取信息，经 Agent 判断后创建/更新 Task。当前有 Job seed、cron、MCP spawn、Agent tools，且 build 已通过；但外部连接、MCP tool discovery、Agent 无头 session 和任务创建效果仍未被运行时验证。periodic-poll 的“预过滤”也只是检查上次运行时间，没有先低成本查询外部系统是否有新数据。

用户结果：早上打开 App 不一定真的有邮件、Teams、PR、日历聚合，也没有明确告诉用户为什么没有数据。

### P0-3: Chat 流式消息与历史刷新可能造成重复消息或错位

Renderer 发送消息时先本地插入用户消息；main 保存用户消息和 agent 消息；stream-end 事件触发 `fetchHistory`；随后 `sendMessage` Promise 返回又把 agent 消息 append 到当前 store。这个时序很容易产生重复 agent 消息，尤其网络慢或 stream-end 比返回先到时。

影响：用户会看到同一回复出现两次，或者 pending action 附着到错误消息，直接破坏 Chat 作为“做事入口”的可信度。

### P0-4: 写操作确认 UX 不足以让用户安全批准

产品要求在 Chat 中展示草稿、目标对象和确认/修改/取消按钮。当前 PendingAction 只有 `执行 ${request.kind}` 这样的描述，UI 没有渲染 details，也没有明确展示“要发给谁、内容是什么、会改哪里”。Modify 流程只是把 description 填进输入框，并且 main 侧只有在传入 modification 时才特殊处理；点击修改通常会同时 reject 原 action。

影响：用户无法审查 Agent 即将执行的真实写操作，确认按钮不安全，修改路径不清楚。

### P0-5: First-run onboarding 缺失

目标用户需要先完成 M365/GitHub 连接、身份记忆、项目、关键关系人、Job 配置。当前没有首次启动向导，也没有 dashboard health check。用户首次打开大概率看到空任务列表和空 chat，不知道下一步该连什么、为什么 Agent 没有 briefing、Job 有没有失败。

## Product Module Feature List

### 1. App Shell / Dashboard / Navigation

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| APP-01 | 独立 Electron 桌面 App | 打开后进入单窗口工作台，本地优先保存数据。 | [DONE] | Electron main/renderer/preload 已存在，SQLite 存在。 |
| APP-02 | 不切页面：任务列表 + Chat 同屏 | 用户始终看到任务全貌，并可随时对话。 | [DONE] | `TaskPanel` + `ChatPanel` 固定布局实现了核心结构。 |
| APP-03 | Chat 永远可用 | 不管在 General 还是 Task 模式，底部输入框始终可用。 | [DONE] | `ChatPanel` 底部输入固定存在。 |
| APP-04 | Dashboard briefing | 早上打开 App，Agent 主动给今日概览和优先建议。 | [PARTIAL] | main 有 `triggerMorningBriefingIfNeeded`，build 已通过；但依赖真实 Agent/Connection runtime，且 UI 没有 briefing loading/error 状态。 |
| APP-05 | Settings 抽屉而非页面 | 齿轮打开右侧抽屉，管理配置。 | [DONE] | SettingsDrawer 已实现 tabs。 |
| APP-06 | 首次启动向导 | 引导连接账号、创建项目、设置 L0、打开/关闭 Jobs。 | [MISSING] | 没有 onboarding，也没有“配置未完成”提示。 |
| APP-07 | 全局错误/健康状态 | 告诉用户 SDK、MCP、Job、OAuth 是否工作。 | [MISSING] | 错误主要在 console 或局部 throw，用户不可见。 |

### 2. Task Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| TASK-01 | Task 数据模型 | 标题、描述、状态、优先级、来源、项目、相关人、时间、UI 状态、Agent 处理记录。 | [PARTIAL] | shared/db 基本齐全，但 `source.connectionId` 缺失，source 不能追溯到具体 connection。 |
| TASK-02 | 用户手动创建任务 | 用户可快速建任务，也应能补描述、优先级、截止、项目、相关人。 | [PARTIAL] | UI 只能输入标题，source=user；没有新建详情表单。 |
| TASK-03 | Agent 从对话创建任务 | 用户说“帮我记一下/处理这个”，Agent 创建 Task。 | [PARTIAL] | `create_task` tool 存在且 build 已通过；但没有 runtime smoke test，也没有 UI 侧确认或反馈非高优任务已创建。 |
| TASK-04 | Job/Connection 自动创建任务 | 邮件、Teams、会议、GitHub 通知进入任务池。 | [PARTIAL] | Job + MCP 骨架存在且 build 已通过，但外部数据拉取与 Agent 决策未被运行时验证。 |
| TASK-05 | Active 列表 | 未完成任务按优先级排序，显示 new、due、overdue。 | [PARTIAL] | Active/Due/new 已显示；没有项目/来源摘要；排序逻辑较粗，deadline 比较依赖字符串。 |
| TASK-06 | Done 历史 | 已完成按日期分组，今天/昨天优先，可展开更早。 | [PARTIAL] | UI 有分组和“更早”；但 cancelled 也被放进“已完成”，容易污染历史与日报语义。 |
| TASK-07 | 任务筛选 | 按优先级、项目、状态筛选。 | [PARTIAL] | main `listTasks(filter)` 支持，UI 没有筛选入口。 |
| TASK-08 | 单任务详情 | 点击任务进入 Task Chat，看到来源、状态、项目、deadline、相关人。 | [PARTIAL] | Header 只显示 priority/source/due/external link；不显示 description/project/relation/result/history。 |
| TASK-09 | Agent 第一条任务说明 | 首次进入 Task，Agent 主动解释任务是什么和建议如何处理。 | [PARTIAL] | `triggerFirstMessage` 存在且 stream 字段已通过类型检查；但依赖真实 Agent runtime，失败后 UI 没 fallback。 |
| TASK-10 | 状态机 | pending -> in_progress -> completed/cancelled；完成/取消不可逆。 | [PARTIAL] | 后端限制 terminal revert；但用户进入/Agent 开始处理不会自动变 in_progress。 |
| TASK-11 | 完成/取消快捷操作 | 用户可 hover、右键、header 完成或取消。 | [DONE] | UI 多处实现。 |
| TASK-12 | 降低优先级 | 用户可把任务沉底。 | [DONE] | 右键菜单设置 priority=low。 |
| TASK-13 | 延后到指定时间 | 用户可选择“周五再看”等；到点重新出现。 | [PARTIAL] | 只有明天/下周快捷项，没有任意时间选择；60s 刷新。 |
| TASK-14 | 批量清理 | 多选批量完成/取消/延后。 | [PARTIAL] | 批量完成/取消存在；批量延后不存在。 |
| TASK-15 | Active 膨胀控制 | 默认只显示 top N，Agent 日终建议清理长期低价值任务。 | [PARTIAL] | 可视上限存在；Agent 主动清理只是 job instruction，没有 UI 批量建议确认。 |
| TASK-16 | 去重 | externalId 精确去重 + 内容相似去重。 | [PARTIAL] | externalId + Jaccard title 实现；中文无空格时相似度很弱，不足以覆盖目标用户语境。 |
| TASK-17 | 自动优先级 | 根据 deadline、relation role、来源自动排序。 | [PARTIAL] | deadline/relation/source 简单评分；没有“被催促过”“项目重要程度”。 |
| TASK-18 | 查看关联来源 | 从 task 跳回邮件/PR/事件。 | [PARTIAL] | externalUrl 只显示一个小箭头；没有来源标题、系统名、可访问错误处理。 |
| TASK-19 | Task 编辑 | 用户能修改标题、描述、状态、优先级、项目、相关人、deadline。 | [MISSING] | 没有 task detail/edit 表单；只能局部快捷改状态/优先级。 |
| TASK-20 | Task 处理结果确认/拒绝 | Agent 处理后用户确认、修改或拒绝结果。 | [PARTIAL] | PendingAction UI 有按钮，但内容和状态流不完整。 |

### 3. Chat / Agent Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| CHAT-01 | General Chat | 用户可自由提问、指令 Agent 创建/查询/处理任务。 | [PARTIAL] | UI 和 Agent 调用路径存在且 build 已通过；仍缺 runtime smoke test 和可见错误状态。 |
| CHAT-02 | Task Chat | 选中 Task 后 Chat 自动带任务上下文。 | [PARTIAL] | 上下文拼装存在且 build 已通过；仍依赖 Agent runtime，UI header 没完整上下文。 |
| CHAT-03 | Chat 历史 | General 与每个 Task 都有持久历史。 | [PARTIAL] | `chat_messages` 存在；但 stream/fetch/append 时序可能重复。 |
| CHAT-04 | Streaming 回复 | Agent 输出流式展示。 | [PARTIAL] | sendMessage 与 triggerFirstMessage 的 stream 字段已通过类型检查；仍未验证真实 SDK 事件顺序，且 chat history/final append 可能重复。 |
| CHAT-05 | Dynamic system prompt | 固定角色 + L0 + Task + Project + Relation。 | [PARTIAL] | 构建函数存在；未见 token budget 真正截断。 |
| CHAT-06 | L1 Memory 检索注入 | 每轮基于用户消息检索相关记忆。 | [PARTIAL] | hook 存在；没有检索日志/引用透明 UI。 |
| CHAT-07 | Project 上下文注入 | 处理任务时知道 repo/docs/tech stack/notes。 | [PARTIAL] | 只注入 description + techStack；repoPath/docsPath/notes 没注入，也没有按需读取能力。 |
| CHAT-08 | Relation 上下文注入 | 处理任务时知道人物角色、专长、沟通风格。 | [PARTIAL] | 已拼接 relation info；但关系自动发现/补充缺失。 |
| CHAT-09 | 内部工具 | memory_write/search、create/update/query_task、generate_report。 | [PARTIAL] | 工具存在；但 update_task 默认确认路径未形成可审查 action card。 |
| CHAT-10 | 外部 MCP tools | Work IQ + GitHub tools 注册到 Agent。 | [SKELETON] | MCP spawn/list/call 框架存在；未验证 server schema、auth token、tool permission。 |
| CHAT-11 | 写操作权限 | 读自动、记忆通知、写确认。 | [PARTIAL] | 规则意图存在；但 `skipPermission` 绕过 create_task/memory_write，默认 handler 的 request kind 与真实 SDK 类型不确定。 |
| CHAT-12 | PendingAction 卡片 | 展示操作内容、目标、确认/修改/取消。 | [PARTIAL] | UI 有按钮，缺少 details 渲染和 taskId 绑定。 |
| CHAT-13 | 修改草稿 | 用户点击“修改”后编辑草稿并重新确认。 | [PARTIAL] | 当前只是把 description 塞进输入框，原 action 通常被 reject；没有二次确认卡片。 |
| CHAT-14 | General 中识别已有 Task | Agent 建议切换到相关任务。 | [SKELETON] | 只有 prompt 指令，没有 UI affordance 或 task switch action。 |
| CHAT-15 | Session 恢复 | Task session/general session 能恢复。 | [PARTIAL] | SDK resume 代码存在且 build 已通过；但 task session 固定 `task-{id}-1`，没有 attempt 管理，也未做恢复失败体验。 |
| CHAT-16 | Session end 归档 | 会话总结进入 L2，Task 处理状态更新。 | [PARTIAL] | L2 写 summary；没有更新 Task working state/result，也没有补漏提取实现。 |

### 4. Connection Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| CONN-01 | M365/Work IQ 连接 | 用户授权后可读取 Outlook/Teams/Calendar/SharePoint/People。 | [SKELETON] | OAuth + MCP 配置存在；真实 Work IQ server/env/token 是否兼容未验证。 |
| CONN-02 | GitHub 连接 | 用户授权后可读写 issues/PR/repos/notifications。 | [SKELETON] | OAuth + MCP 配置存在；MCP server 通常需要 token env 名称确认。 |
| CONN-03 | 添加/移除外部连接 | 用户可连接、重新授权、断开。 | [PARTIAL] | UI 有连接/断开；断开后没有主动 stop MCP server，也没有状态事件。 |
| CONN-04 | 权限配置只读/读写 | 每个 connection 可配置权限范围。 | [MISSING] | UI 只有 OAuth client config；没有只读/读写级别。 |
| CONN-05 | OAuth 配置 | 用户填写 client id/tenant/token 配置。 | [PARTIAL] | 可保存；但 GitHub client secret 作为普通 config 明文存入 `memory_entries`，风险高。 |
| CONN-06 | Token refresh | 授权过期后自动刷新或提示。 | [MISSING] | refresh token 被存储但没有使用刷新流程。 |
| CONN-07 | 连接状态可解释 | 显示未配置/未授权/授权失败/MCP 启动失败。 | [PARTIAL] | lastError 只有 authenticate catch；MCP 启动失败只 console.error。 |
| CONN-08 | 外部来源可追溯 | Task 可知道来自哪个 connection、哪条邮件/PR。 | [PARTIAL] | externalId/externalUrl 存在；connectionId 缺失。 |

### 5. Project Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| PROJ-01 | Project CRUD | 用户可创建、查看、编辑、删除项目。 | [PARTIAL] | UI + IPC + DB 存在。创建时 `notes` 字段被 UI 提交但 `CreateProjectInput`/insert 没保存，用户输入会静默丢失。 |
| PROJ-02 | repo/docs 路径 | Agent 处理代码/文档任务时能定位仓库和文档。 | [PARTIAL] | 字段保存；Agent 未用 repoPath/docsPath 搜索或读取。 |
| PROJ-03 | techStack/team/notes | 为 Agent 提供软上下文。 | [PARTIAL] | techStack/team 保存；create notes 丢失；Agent 不注入 notes/team。 |
| PROJ-04 | 任务关联项目 | Task 可关联 Project 并按项目过滤。 | [PARTIAL] | 数据模型/API 支持；UI 新建/编辑任务不能关联项目，列表也不显示项目。 |
| PROJ-05 | Agent 补充项目信息 | 对话中学习项目描述、惯例、备注。 | [SKELETON] | 只有 updateProject API，没有 Agent tool。 |

### 6. Relation Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| REL-01 | Relation CRUD | 用户配置老板、同事、外部人等。 | [PARTIAL] | UI + IPC + DB 存在。创建时 `notes` 字段同样会静默丢失。 |
| REL-02 | role/timezone/expertise/style | Agent 用于优先级和沟通方式。 | [PARTIAL] | 字段存在；自动使用只体现在 priority role 简单加分和 context 拼接。 |
| REL-03 | 关系自动发现 | Agent 从信息流中识别新人并提议添加。 | [MISSING] | 没有 tool、UI pending suggestion 或 job 逻辑。 |
| REL-04 | 自动补充关系属性 | Agent 从交互观察沟通偏好、专长等。 | [SKELETON] | docs 有设想，代码无实现。 |
| REL-05 | 删除后的引用清理 | 删除 relation 后任务/记忆引用不残留。 | [PARTIAL] | task related ids 会清理；memory 中的人物知识不会处理。 |

### 7. Skill / Tool Visibility

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| SKILL-01 | 查看内置 Skill/Tool 列表 | Settings 中看到 Agent 能做什么。 | [MISSING] | docs/skill.md 定义 Skill 是 tool UI 分组，但 Settings 没有 Skill tab。 |
| SKILL-02 | 自定义 Skill | 用户创建/编辑自定义能力。 | [MISSING] | PRODUCT MVP 写了添加/编辑自定义 Skill；skill.md 后来弱化为 UI grouping，两者定义冲突，需要产品决策。 |
| SKILL-03 | Tool 注册 | Agent session 注册内部 + MCP tools。 | [PARTIAL] | `buildTools` 存在且 build 已通过；MCP tool discovery/call 仍未运行时验证。 |
| SKILL-04 | Tool 权限说明 | 用户知道哪些自动、哪些需确认。 | [PARTIAL] | Preferences 有 autonomyLevel，但没有每个 tool 的可见解释。 |

### 8. Job Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| JOB-01 | 默认晨间聚合 | 工作日早上收集新信息并生成任务/briefing。 | [PARTIAL] | seed + scheduler 存在且 build 已通过；依赖 Agent/Connections runtime，缺少运行中/失败可见状态。 |
| JOB-02 | 定时轮询 | 每 15 分钟检查新邮件/Teams/GitHub。 | [PARTIAL] | scheduler 存在；没有真实低成本外部预过滤，也未验证 MCP 数据拉取。 |
| JOB-03 | 日终对账 | 补建遗漏任务、更新已完成状态、建议清理、生成日报。 | [PARTIAL] | job instruction 存在；没有可确认的清理 UI、日报入口或对账结果明细。 |
| JOB-04 | Job 列表 | 用户查看内置 jobs、频率、上次结果。 | [PARTIAL] | Settings 展示 job 和 lastSummary。 |
| JOB-05 | Job toggle | 用户可启用/停用。 | [PARTIAL] | IPC 有 toggle；UI 点击后不刷新 store，开关视觉状态可能不更新。 |
| JOB-06 | 创建/编辑/删除 Job | 用户配置频率和指令。 | [MISSING] | docs 要求 CRUD，当前只有 toggle。 |
| JOB-07 | Job 执行记录 | 用户查看历史运行日志。 | [PARTIAL] | 只有 last result/summary，没有历史列表、耗时、错误堆栈、创建了哪些任务。 |
| JOB-08 | Job 失败通知 | SDK/connection/auth 失败时用户知道。 | [MISSING] | catch 写 last_summary，但没有事件通知，也没有 dashboard health。 |

### 9. Memory Module

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| MEM-01 | L0 Identity 查看/编辑 | 用户编辑核心身份档案，8K 限制可见。 | [DONE] | Memory tab 有 textarea 和字数。 |
| MEM-02 | L1/L2 列表 | 用户浏览 Agent 积累的记忆。 | [PARTIAL] | 只列 active L1/L2 前 100 条；无分页。 |
| MEM-03 | Memory 搜索/过滤 | 按层、项目、标签、状态搜索。 | [MISSING] | API 有 list/search 部分能力；UI 无搜索/过滤。 |
| MEM-04 | L1 编辑 | 用户纠正错误记忆内容和标签。 | [MISSING] | UI 只能删除。 |
| MEM-05 | 删除任何记忆 | 用户可删除错误/敏感记忆。 | [PARTIAL] | UI 删除 L1/L2；L0 可覆盖；没有删除确认。 |
| MEM-06 | inactive 审计链 | 错误记忆标记 inactive，不再检索但可审计。 | [PARTIAL] | `markMemoryInactive` 存在但 UI/Agent tool remove 是硬删除。 |
| MEM-07 | FTS5 检索 | Agent 可用关键词检索记忆。 | [PARTIAL] | searchMemory 实现；中文分词和 query escaping 可能不足。 |
| MEM-08 | 检索透明 | 用户能问“这轮用了哪些记忆”，并看到来源。 | [MISSING] | 没有 retrieval log，也没有回答引用机制。 |
| MEM-09 | Session/Task 归档到 L2 | 完成任务后长期保留结论。 | [PARTIAL] | onSessionEnd 写 finalMessage；没有 task completed hook，也不清理 task 工作状态。 |
| MEM-10 | Memory 导出 | 导出 JSON/Markdown。 | [MISSING] | 路线图/用户控制提到，代码无。 |
| MEM-11 | Secret 与 Memory 隔离 | OAuth secret/token 不应混在用户记忆模型里。 | [PARTIAL] | token 加密后放 L0 表；GitHub client secret 明文放 config；架构上容易和用户可编辑 memory 混淆。 |

### 10. Report / Daily / Weekly Summary

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| RPT-01 | 生成日报 | 用户下班前看到基于任务和信息流的日报。 | [SKELETON] | `generate_report` tool 只统计 task 状态；日终 job instruction 提到日报，但无 UI 查看/确认。 |
| RPT-02 | 生成周报 | 用户可主动让 Agent 汇总一周。 | [SKELETON] | Tool 支持 weekly 参数；无明确 UI 或 prompt shortcut。 |
| RPT-03 | 把外部已完成事项纳入报告 | 邮件已回复、PR 已 merge 等自动对账。 | [MISSING] | 需要 Connection + Job + Agent 判断，当前无真实闭环。 |
| RPT-04 | 报告可编辑/确认/复制 | 用户能审查、修改、发送或复制。 | [MISSING] | 没有 report view 或 confirmation card。 |

### 11. Preferences / Notifications

| ID | Feature | Expected user experience | Implementation status | Audit notes |
|---|---|---|---|---|
| PREF-01 | 语言偏好 | Agent 按中文/英文回复。 | [PARTIAL] | 写入 preferences 并进入 system prompt；依赖 Agent。 |
| PREF-02 | 自主级别 | default/auto/confirm 控制确认策略。 | [PARTIAL] | UI 与 handler 存在；tool skipPermission 和真实 SDK request kind 可能让策略失效。 |
| PREF-03 | 系统通知 | 高优紧急任务弹系统通知。 | [PARTIAL] | 仅 create_task tool 创建 high priority 时触发；外部 Job/连接状态失败不通知。 |
| PREF-04 | Active 上限 | 用户配置侧边栏显示任务数。 | [DONE] | UI + store 使用。 |
| PREF-05 | 主题偏好 | 用户配置主题。 | [MISSING] | PRODUCT 提到通知/主题偏好，代码无主题选项。 |

## User Journey Audit

### UF-01: 第一次启动 App

期望路径：打开 App -> 看到欢迎/健康状态 -> 连接 M365/GitHub -> 填写身份记忆 -> 添加项目/关系人 -> 确认 Jobs -> 得到第一份 briefing。

当前状态：[MISSING]

实际体验：用户会看到空任务列表和空 Chat。Settings 里能连接，但没有明确顺序、没有缺失项检查、没有解释 Work IQ/GitHub OAuth 配置从哪里来。SDK 初始化失败或 MCP 启动失败主要进入 console。

关键问题：这个产品高度依赖外部连接和个人上下文，缺少 onboarding 会让用户误以为产品“什么都没做”。

### UF-02: 早上 9 点开工看全貌

期望路径：App 已后台/打开后自动运行晨间聚合 -> 左侧出现新任务 -> 右侧 General Chat 有 briefing -> 用户点击最高优任务。

当前状态：[PARTIAL]

已有：default morning job、`triggerMorningBriefingIfNeeded`、Chat message 注入。

缺口：build 已通过，但未验证真实 Agent/Connection runtime；没有显示 job 正在运行；没有“上次聚合失败，因为未连接 M365/GitHub”；没有展示本次创建了哪些任务；briefing 可能仅保存为 chat message，Dashboard 没有专门摘要区域。

### UF-03: 扫描任务全貌

期望路径：用户 30 秒内看到 Active 顶部、优先级、deadline、new 标记、来源、项目和任务数量。

当前状态：[PARTIAL]

已有：Active/Done 分区、优先级色点、new 点、due 文案、上限展开。

缺口：来源和项目不可见；无法按项目/状态/优先级筛选；没有“为什么这个任务高优先级”的解释；cancelled 混入 Done；列表健康清理只是隐藏/展开，不是真维护。

### UF-04: 用户手动创建任务

期望路径：用户快速输入标题；必要时补 deadline/project/relation/priority；任务进入 Active 并可立即处理。

当前状态：[PARTIAL]

已有：侧栏 `+` 输入标题创建。

缺口：只能填标题；不能填描述、截止、项目、相关人；新任务创建后不自动选中，也没有进入 Task Chat 的引导。

### UF-05: 点击任务进入处理上下文

期望路径：点击任务 -> new 标记消失 -> Chat 进入 Task 模式 -> Agent 第一条说明任务来源/背景/建议 -> 用户直接说“处理它”。

当前状态：[PARTIAL]

已有：selectTask、markSeen、TaskHeader、triggerFirstMessage 入口。

缺口：build 已通过，但 first message 仍未做 runtime smoke test；失败无 fallback；header 信息太薄；任务不会进入 in_progress；没有静态详情兜底。

### UF-06: General 快速提问历史事实

期望路径：用户问“上周 A 说 deadline 是几号？” -> Agent 检索 Memory + Work IQ -> 给答案和来源。

当前状态：[PARTIAL]

已有：General chat、memory_search、Work IQ MCP 设计。

缺口：build 已通过，但 Agent runtime、Work IQ、Memory 检索注入效果未验证；Memory 检索没有来源透明；没有告诉用户答案来自哪里。

### UF-07: Agent 处理任务并执行写操作

期望路径：用户说“approve PR 并评论 LGTM” -> Agent 读取 PR diff -> 生成计划 -> 显示确认卡片，包含目标 PR、评论内容、影响 -> 用户确认 -> 执行 -> 任务完成。

当前状态：[SKELETON]

已有：MCP tools 框架、permission request、PendingAction UI。

缺口：MCP/GitHub 未验证；确认卡片不展示实际操作细节；pending action 无 taskId；执行后没有强绑定 task completion；失败恢复缺失。

### UF-08: 修改 Agent 草稿

期望路径：Agent 给邮件草稿 -> 用户点修改 -> 草稿进入编辑态 -> 用户改完 -> 再次确认发送。

当前状态：[PARTIAL]

已有：ActionCard 的修改按钮、modifyDraft store。

缺口：填入的是 action description，不是真实草稿；修改后只是普通 chat 输入，没有重新生成确认卡；原 permission promise 可能已 reject。

### UF-09: 用户自己完成/取消/延后任务

期望路径：用户 hover/右键/header 完成、取消、降低优先级、延后到某天；列表立即更新；Done 记录完成时间。

当前状态：[PARTIAL]

已有：完成/取消/降低/明天/下周延后、批量完成/取消。

缺口：没有任意日期；取消任务在 Done 中像已完成一样显示；完成/取消没有 undo；没有错误 toast；完成后仍停留在已完成 task chat。

### UF-10: 配置外部连接

期望路径：用户在 Settings 看到 M365/GitHub 状态，点连接，完成授权，状态变绿；失败时知道原因和下一步。

当前状态：[PARTIAL]

已有：连接列表、OAuth window、config 表单、status event。

缺口：没有 admin consent/redirect URI 指引；GitHub secret 明文保存；MCP 启动失败不可见；断开不停止 server；没有只读/读写权限配置。

### UF-11: 配置 Project / Relation

期望路径：用户添加项目和关系人；Agent 后续自动用这些信息。

当前状态：[PARTIAL]

已有：CRUD UI 和 DB。

缺口：Project/Relation 创建时 notes 静默丢失；Task 不能在 UI 上关联项目/关系人；Agent 只用少量字段；没有自动补全或提议添加。

### UF-12: 查看与纠正 Memory

期望路径：用户看到 L0/L1/L2，搜索、过滤、编辑、删除；纠正后 Agent 不再重复错误。

当前状态：[PARTIAL]

已有：L0 编辑、L1/L2 列表、删除。

缺口：不能搜索/过滤/编辑 L1；删除无确认；inactive 审计链没有 UI；Agent 更正旧记忆只是 prompt 要求，缺少工具流验证。

### UF-13: 管理 Jobs

期望路径：用户查看晨间/轮询/日终 job，修改时间，手动运行，查看历史。

当前状态：[PARTIAL]

已有：列表、toggle、last summary。

缺口：toggle 后视觉可能不刷新；无创建/编辑/删除/手动运行；无历史执行记录；失败不主动提示。

### UF-14: 生成日报/周报

期望路径：用户或日终 job 触发 -> Agent 汇总任务、外部事件、已完成未建任务 -> 生成可编辑报告。

当前状态：[SKELETON]

已有：generate_report tool 统计 task 数量。

缺口：不检索 L2 或外部系统；无 report UI；无编辑/确认/复制路径；日终对账不能自动识别“用户已在外部完成”。

### UF-15: 出错和恢复

期望路径：OAuth 失败、SDK 失败、MCP 失败、Job 失败、DB 失败、Agent 超时都有用户可理解的提示和重试。

当前状态：[MISSING]

当前多数失败路径只进入 console、throw，或在 chat 中显示一条错误消息。没有全局 toast、health panel、retry button、debug export。

## Key Product Risks

1. Agent 依赖太集中，但没有降级体验。当前 Chat/Job/Briefing/Task first message 都依赖 SDK；一旦 SDK 失败，产品需要仍然像一个可靠任务台，而不是空白。
2. “任务即上下文”的设计还没有落地。Task Header 太薄，Task 详情没有静态兜底，Project/Relation/Memory 注入也未覆盖关键字段。
3. 确认交互没有达到“可审查”。写操作必须展示操作对象、内容、权限、后果和失败恢复；当前只是 generic action。
4. Settings 是配置表单集合，不是成功路径。用户需要知道哪些配置必需、当前缺什么、下一步是什么。
5. 自动化没有可观测性。Job 到底检查了什么、创建了哪些 task、跳过了什么、失败在哪，用户不可见。
6. Memory 的“可纠正”还不够。能看和删不等于可纠正；需要搜索、编辑、来源、inactive 状态和本轮使用透明。
7. 数据安全边界不清楚。OAuth token/config/preference/window state 与 Memory 共享一张表，GitHub secret 明文保存，这会让“用户拥有记忆”与“应用内部机密”混在一起。

## Recommended Implementation Order

### Phase 1: Make the existing skeleton trustworthy

1. 增加 Agent runtime smoke test：General chat、Task first message、create_task tool、job session 各跑一条可复现路径。
2. 修复 Chat store/main IPC 的 stream-end/history/final append 时序，保证消息不重复。
3. 为 SDK/MCP/Job 增加可见 health 状态：未初始化、未授权、运行中、失败、可重试。
4. 补齐 PendingAction 的 details 渲染和 taskId 绑定，修改流程改成“编辑草稿 -> 重新确认”。
5. 修复 Project/Relation create 时 notes 静默丢失。

### Phase 2: Close core MVP user paths

1. 做首次启动 checklist：连接 M365/GitHub、填写 L0、添加项目、添加关系人、确认 Jobs。
2. 做 Task 详情/编辑能力：描述、优先级、deadline、project、relations、source、result。
3. 让 Task 进入/退出 in_progress 有明确规则：用户进入、Agent 开始处理、完成/取消。
4. Job 增加手动运行、历史记录、失败展示；periodic-poll 做真实外部预过滤。
5. Memory 增加搜索、过滤、编辑、inactive、来源展示。

### Phase 3: Make the product feel like an agent, not a todo app

1. Morning briefing 显示本次读取范围、创建/更新任务、跳过原因和建议。
2. 日终对账增加“建议清理”确认卡，而不是只写在 summary 里。
3. Report view 支持编辑、复制、确认发送。
4. Skill/Tool 可视化：告诉用户 Agent 能做什么、哪些操作需要确认。
5. 外部来源深链接与权限配置完善：只读/读写、连接级 scope、token refresh。
