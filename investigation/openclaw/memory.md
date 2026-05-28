# OpenClaw Memory System 调研

## 核心发现

Memory 不是主动保存的——系统被动追踪什么被"搜索召回"过，高频召回的内容通过 "dreaming" 合并流程晋升为长期记忆。

## 存储分层

| 层 | 存储位置 | 何时加载到 Context | 写入者 |
|---|---|---|---|
| 长期记忆 | `MEMORY.md` | 每次 session 启动 | 仅 Deep dreaming 阶段 |
| 短期记忆 | `memory/YYYY-MM-DD.md` | 今天 + 昨天自动加载 | Agent 在对话中写入 |
| 召回追踪 | `.dreams/short-term-recall.json` | 从不直接加载 | 每次 memory_search 调用时记录 |
| 索引 | `~/.openclaw/memory/<id>.sqlite` | 从不直接加载（被查询） | sync/reindex |

## 搜索机制：混合多路

SQLite 数据库，每个 agent 一个库：
- **chunks 表**: ~400 token 分块，80 token 重叠
- **FTS5 虚拟表**: BM25 关键词评分
- **sqlite-vec**: 向量余弦相似度
- **时间衰减**: 14 天半衰期
- **MMR**: Maximal Marginal Relevance，保证结果多样性

最终分数 = 加权合并以上信号。

## 合并机制："Dreaming" 三阶段睡眠周期

1. **Light（浅睡）** — 摄入并去重最近的信号
2. **REM（快速眼动）** — 提取模式和主题
3. **Deep（深睡）** — 用 6 个加权信号打分，晋升优胜者到 MEMORY.md

打分权重：
- frequency: 0.24
- relevance: 0.30
- diversity: 0.15
- recency: 0.15
- consolidation: 0.10
- conceptual richness: 0.06

**晋升门槛**: score ≥ 0.8, 被召回次数 ≥ 3, 独立查询数 ≥ 3

## 遗忘

- MEMORY.md 超过 10K 字符时触发 budget compaction（丢弃最旧的已晋升段落）
- `memory_forget` 工具做 GDPR 级别的完整删除
- `maxAgeDays: 30` 老化召回候选

## 关键设计启发

1. **被动学习而非主动保存** — 不是"决定要记住什么"，而是"什么被反复需要就记住什么"
2. **召回频率驱动晋升** — 真正有用的记忆自然会被频繁检索
3. **分块 + 多路召回** — 不依赖单一搜索策略
4. **离线合并** — "dreaming" 是异步后台过程，不影响实时交互
