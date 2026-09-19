# 代码补全：SiliconFlow FIM 模型实测与预置表修正

> **日期**: 2026-09-18
> **状态**: 已实施
> **触发**: 用户反馈「测试连接」失败 —— `HTTP 400: {"code":20031,"message":"FIM is not supported for this model.","data":null}`（平台 SiliconFlow，模型 `deepseek-ai/DeepSeek-V4-Flash`）
> **关系**: 更正 `2026-09-17-code-completion-platform-support-design.md` §2 的模型清单结论

---

## 0. 结论（TL;DR）

`/v1/completions` 的 FIM 通路**没有问题**，`DeepSeekFimClient` 构造的请求体也**没有问题**（同一请求体在可用模型上稳定 200）。问题只在**预置表里列了一批网关不会跑 FIM 的模型**，而列表第一项恰好就是坏的那个，于是「切到 SiliconFlow」必然自动填入坏模型，测试必然 400。

根因：09-17 的调研把「模型广场里有这个模型」当成了「支持 FIM」。**模型存在 ≠ 接受 `suffix`**，必须逐模型带 `suffix` 实测。

---

## 1. 实测（2026-09-18，真实 key，`POST https://api.siliconflow.cn/v1/completions`）

请求体与插件 `buildRequestBody` 完全一致：
`{model, prompt, suffix, max_tokens, temperature:1, top_p:1, stop:["\n\n"], ignore_eos:false, stream:false}`；
`prompt = "public static int add(int a, int b) {\n    return "`，`suffix = ";\n}\n"`。

| 模型 | 结果 | 判定 |
|---|---|---|
| `deepseek-ai/DeepSeek-V3` | **200** `text="a + b"` | ✅ |
| `deepseek-ai/DeepSeek-R1` | **200** `text="a + b"` | ✅ |
| `Pro/deepseek-ai/DeepSeek-V3` | **200** `text="a + b"` | ✅ |
| `Qwen/Qwen3-Coder-30B-A3B-Instruct` | **200** `text="a + b"` | ✅ |
| `deepseek-ai/DeepSeek-V4-Flash` | **400** `20031 FIM is not supported for this model` | ❌ 原预置首选，即本次故障 |
| `deepseek-ai/DeepSeek-V4-Pro` | **400** `20031` | ❌ |
| `deepseek-ai/DeepSeek-V3.2` | **400** `20031` | ❌ 原预置项 |
| `deepseek-ai/DeepSeek-V3.1-Terminus`、`Pro/…-Terminus` | **400** `20031` | ❌ |
| `Qwen/Qwen3-30B-A3B-Instruct-2507`、`Qwen/Qwen3.6-35B-A3B` | **400** `20031` | ❌ |
| `moonshotai/Kimi-K2.7-Code`、`zai-org/GLM-4.5-Air`、`tencent/Hunyuan-A13B-Instruct`、`ByteDance-Seed/Seed-OSS-36B-Instruct` | **400** `20031` | ❌ |
| `Pro/zai-org/GLM-5.1` | **400** `20015 Value error, suffix is not allowed` | ❌ 拒绝 suffix |
| `Qwen/Qwen2.5-Coder-32B-Instruct` | **403** `30003 Model disabled` | ❌ 已下架 |

补充事实：
- `ignore_eos: true` 在可用模型上同样 **200**，该参数不构成故障源。
- `GET /v1/models` 的模型对象只有 `{id, object, created, owned_by}`，**没有任何 FIM 能力标记**，因此无法在 UI 侧动态过滤，只能静态维护白名单 + 用「测试连接」兜底。
- 官方文档（docs.siliconflow.cn）现在只演示 `/chat/completions` + `extra_body.{prefix,suffix}`；实测该路由**忽略** `extra_body`，返回的是普通对话回答而不是中段补全，故不做「chat 伪 FIM」（与 09-17 设计 §3「不做」一致）。

---

## 2. 改动

| 文件 | 改动 |
|---|---|
| `webview/.../CodeCompletionSection/index.tsx` | SiliconFlow 预置模型改为实测可用四项：`deepseek-ai/DeepSeek-V3`（首选）、`Qwen/Qwen3-Coder-30B-A3B-Instruct`、`Pro/deepseek-ai/DeepSeek-V3`、`deepseek-ai/DeepSeek-R1`；移除 `DeepSeek-V4-Flash` / `DeepSeek-V3.2`；注释写明「只允许实测 200 的模型」 |
| 同上 | 新增 FIM 不支持提示：`error` 命中 `20031` / `FIM is not supported` / `suffix is not allowed` 时，在失败结果下方列出当前平台的可用模型（`data-testid="code-completion-fim-hint"`），自定义平台给通用指引 |
| `webview/src/i18n/locales/{zh,en}.json` | 新增 `fimUnsupported` / `fimUnsupportedCustom` 两条文案 |
| `webview/.../CodeCompletionSection/index.test.tsx` | 新增 2 条回归：切 SiliconFlow 必须填入可用的 FIM 模型（且不是 V4-Flash）；20031 失败必须给出可用模型提示，通用 404 不得出现该提示 |
| `docs/plans/2026-09-17-…-design.md` | §2 的模型清单结论标注更正并指向本文 |

**未改动**：`DeepSeekFimClient` / `FimCompletionContributor` / `CodeCompletionSettings` —— 协议与解析实测均正确，本次是纯数据（预置表）错误。

---

## 3. 用户侧需要做的一步

修正的是预置表，**不会自动改写已存配置**（沿用 09-17 评审「只提示，不擅自改用户配置」的结论）。本机 `~/.codemoss/config.json` 里仍是坏模型：

```json
"codeCompletion": { "preset": "siliconflow", "model": "deepseek-ai/DeepSeek-V4-Flash", ... }
```

操作：设置里把「平台」重选一次 **SiliconFlow**（会填入 `deepseek-ai/DeepSeek-V3`），保存后再点「测试连接」；或直接把「模型」改成上表任一 ✅。

---

## 4. 验证

- `webview: npx vitest run src/components/settings/CodeCompletionSection/index.test.tsx` → 9 passed。
- 真实探测：上表四款 ✅ 模型均返回 200 且 `choices[0].text="a + b"`（即插入光标的正是中段补全片段）。
- Java 侧无改动，回归见 `./gradlew test --tests "*CodeCompletion*" --tests "*Fim*"`。
