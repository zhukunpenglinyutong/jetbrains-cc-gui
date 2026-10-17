# OpenCode 1.18.32 `run --format json` 原始事件采样

> 采集日期：2026-09-29 · opencode CLI 1.18.32（Windows, npm 安装）
> 模型：`opencode/mimo-v2.6-flash-free`（免费档，仅用于复现事件形态）
> 用途：`2026-09-29-opencode-process-display-plan.md` 的根因证据；可改造为
> `ai-bridge/services/opencode/message-service.test.js` 的回放 fixtures。

## 采集命令

```bash
# 工具调用回合（bash 快速执行）
opencode run --format json --model <model> "Use the bash tool to run: echo hello-from-opencode. Then reply briefly."
# → tool-call-turn.jsonl

# 工具调用回合（bash 含 sleep 6，验证是否存在 pending/running 中间事件）
opencode run --format json --model <model> "Use the bash tool to run: sleep 6 && echo done-sleeping. Then reply briefly."
# → slow-tool-turn.jsonl（答案：没有中间事件，仍只有单个 completed）

# 纯文本长回复（200 词故事，验证流式粒度）
opencode run --format json --model <model> "Write a 200-word story about a robot."
# → long-text-turn.jsonl（答案：整个 text part 结束后才输出一条完整文本）

# 思考回合，带 --thinking
opencode run --format json --thinking --model <model> "Think step by step: what is 17*23? ..."
# → thinking-turn-with-flag.jsonl（出现 {"type":"reasoning","part":{"type":"reasoning",...}}）

# 思考回合，不带 --thinking（对照组）
opencode run --format json --model <model> "Think step by step: what is 17*23? ..."
# → thinking-turn-without-flag.jsonl（0 条 reasoning 事件；step_finish.tokens.reasoning 仍有值）
```

## 关键结论

1. **无流式**：text/reasoning part 仅在完成时（`part.time.end` 已设置）输出**一次完整内容**；
   tool part 仅在 `state.status ∈ {completed, error}` 时输出。无任何 delta 事件。
2. **`--thinking` 默认关闭**（非交互 run 模式）：reasoning part 完全不输出，加 flag 才有。
3. **工具是单事件**：`{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"call_…",
   "state":{"status":"completed","input":{…},"output":"…"}}}` —— 没有 started→completed 两段式。
4. 事件骨架：`step_start → (reasoning|text|tool_use)* → step_finish`，每步循环一次。
