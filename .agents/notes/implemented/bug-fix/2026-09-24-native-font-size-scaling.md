# Agent Note: 使用真实字号实现聊天字体缩放

Status: implemented

## Problem

JCEF 使用 OSR 位图渲染。通过 CSS `zoom` 缩放整个应用时，字形可能按原字号光栅化后再被放大，导致 100% 以外的聊天文字和代码显示模糊。

## Decision

字号档位继续使用现有 `--font-scale`，但不再缩放 `#app`。会话正文、代码块和输入框统一读取 `--cc-gui-chat-font-size = IDE 编辑器基准字号 × 字号档位`，由 Chromium 按目标字号原生光栅化。通用 JCEF 重绘仍可短暂修改 `zoom`，写后必须清空，避免重新引入缩放。

## Alternatives considered

- 保留 `zoom` 并改用 transform：两者都会把已光栅化内容按位图缩放，无法解决 OSR 下的字形清晰度问题。
- 仅缩放正文：输入框、代码块和依赖 em 的组件会与正文比例不一致，且重绘逻辑仍需长期维护两套缩放机制。

## Consequences

收益是各字号档位都使用真实字号并保持清晰。代价是固定 px 的边框和间距不再随档位放大，行为更符合“字号”而非“整个界面缩放”。JCEF 恢复与通用重绘改用整页重新光栅化，相关单测明确要求临时 `zoom` 最终清空。
