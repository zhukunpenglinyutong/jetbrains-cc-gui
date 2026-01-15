# Webview 性能优化指南

本文档记录了我们在优化聊天界面性能时的关键发现和解决方案，旨在为后续开发提供指导，避免类似的性能瓶颈再次出现。

## 1. 核心原则：对象引用稳定性 (Object Identity Stability)

在 React 应用中，性能优化的基石是**对象引用的稳定性**。

### 问题背景
当我们从后端接收到新的消息列表 JSON 字符串时，`JSON.parse()` 每次都会生成全新的对象树。即使消息内容完全没有变化，新旧对象的内存地址也是不同的。

这会导致：
1. **React.memo 失效**：所有子组件检测到 props 变化（引用变了），强制重新渲染。
2. **Memoization 失效**：`useMemo` 依赖项变化，重新计算派生状态。
3. **缓存失效**：基于对象的缓存（如 `WeakMap`）无法命中。

### 解决方案：智能对象复用 (Smart Object Reuse)

在更新状态前，我们必须进行“智能合并”，尽可能复用旧对象的引用。

**代码位置**: `src/hooks/useWindowCallbacks.ts`

```typescript
// ❌ 错误做法：直接使用新解析的对象
setMessages(parsedMessages);

// ✅ 正确做法：复用旧对象引用
setMessages(prev => {
  return parsedMessages.map((newMsg, i) => {
    // 尝试在旧列表中找到对应的消息
    const oldMsg = prev[i]; 
    // 如果关键特征（时间戳、类型、内容长度）一致，则复用旧对象
    if (oldMsg && isEffectivelySame(oldMsg, newMsg)) {
      return oldMsg; // <--- 关键：返回旧引用
    }
    return newMsg;
  });
});
```

## 2. 昂贵计算的缓存策略

对于必须进行的昂贵计算（如 Markdown 解析、消息块标准化），我们采用了二级缓存策略。

### WeakMap 缓存
由于我们保证了对象引用的稳定性（见第1点），我们可以使用 `WeakMap` 来缓存计算结果。

**代码位置**: `src/App.tsx`

```typescript
const normalizeBlocksCache = useRef(new WeakMap<object, ClaudeContentBlock[]>());

const normalizeBlocks = useCallback((raw) => {
  // 1. 检查缓存
  if (normalizeBlocksCache.current.has(raw)) {
    return normalizeBlocksCache.current.get(raw);
  }
  // 2. 执行昂贵计算
  const result = expensiveParsing(raw);
  // 3. 存入缓存
  normalizeBlocksCache.current.set(raw, result);
  return result;
}, []);
```

**原理**: 当 `raw` 对象引用不变时，解析操作的时间复杂度从 O(N) 降低到 O(1)。

## 3. 派生数据的“对象稳定性”：避免合并结果每次重建

当消息很多时，UI 卡顿不一定来自“某一次计算很慢”，更多时候来自：

- 同一个派生计算每次都在做（过滤、合并、解析）。
- 派生计算产物在引用层面不稳定，导致下游缓存、`React.memo`、`useMemo` 命中率下降。

### 3.1 典型陷阱：合并算法的重复拷贝（隐式 O(n²)）

我们有一个历史兼容逻辑：将连续的 assistant 消息合并，修复 Thinking / ToolUse 被拆分导致的展示问题。

错误/低效形态通常长这样：

```ts
// ❌ 性能陷阱：每合并一次都在创建一个更大的新数组
combined = [...combined, ...next]
```

当连续 assistant 段落很长（比如工具调用多、思考多、流式拆段多），上面的写法会造成大量重复拷贝，最终表现为：

- `App.mergedMessages` 耗时随消息量增长得很快
- 用户在输入/发送时出现可感知的主线程卡顿

正确做法是改为线性累积：

- 扫描连续 assistant 分组，一次性合并
- 使用 `push(...blocks)` 或者预分配策略，避免反复 `[...]` 产生的重复拷贝

对应实现位置：

- `src/utils/messageUtils.ts`：`mergeConsecutiveAssistantMessages(...)`

### 3.2 更关键的点：合并“结果对象”要可复用（否则下游一直重渲染）

即使你把合并算法改成线性，如果每次 `mergedMessages` 计算都创建全新的“合并后 message 对象”（尤其是 `raw` 对象），仍然会触发：

- `WeakMap` 缓存命中率下降（key 是对象引用）
- `MessageItem` 的 `memo` 命中率下降（prop 引用变化）
- 列表渲染更频繁（即使列表项做了 memo，也会有更多工作量）

解决方案：为合并结果引入缓存，让“同一段连续 assistant 分组”的合并产物在输入不变时复用旧对象引用。

实现策略：

- 使用 `Map` 以“分组边界 + 分组长度”作为 key（例如首尾 uuid/timestamp + length）
- 缓存 value 保存：
  - `source`: 该分组输入消息引用数组
  - `merged`: 合并后的 message 对象
- 当下一次计算时，若 `source` 中每个引用都与当前分组一致，则直接返回 `merged` 复用引用
- 注意内存：Map 是强引用，应限制 size，并在切换 session / i18n 变化时清空

对应实现位置：

- `src/App.tsx`：`mergedAssistantMessageCache` + `mergeConsecutiveAssistantMessages(..., cache)`

## 4. 过滤/判定的缓存：shouldShowMessage WeakMap

`mergedMessages` 的第一步通常是过滤出可见消息：

- 这一步是 O(n) 扫描，在消息很多时会成为固定成本
- `shouldShowMessage(message)` 对“同一条 message 对象”而言是纯函数（在 `t/localizeMessage` 不变的前提下）

因此可以用 WeakMap 做 memoization：

```ts
const cache = new WeakMap<object, boolean>()
// message 作为 key：对象被 GC 后缓存自动释放
```

注意事项：

- 依赖 `t` / `localizeMessage` 变化时，缓存必须清空，否则会出现“语言切换后过滤逻辑不一致”的问题
- 不要使用 `Map` 做 message -> boolean 的长期缓存，它会强引用消息对象导致内存常驻

对应实现位置：

- `src/App.tsx`：`shouldShowMessageCache`

## 5. UI 响应性优化（让用户感觉“零延迟”）

为了让用户感觉“零延迟”，我们需要将**UI反馈**与**数据处理**解耦。

### 任务递延 (Task Deferral)
不要在用户交互的同一帧中执行繁重的逻辑。

**代码位置**: `src/components/ChatInputBox/ChatInputBox.tsx`

```typescript
const handleSubmit = () => {
  // 1. 立即更新 UI（清空输入框）
  clearInput();
  
  // 2. 将繁重的提交逻辑推迟到下一帧执行
  setTimeout(() => {
    onSubmit(content); // 发送网络请求、处理附件等
  }, 10);
};
```

### 乐观更新 (Optimistic Updates)
不要等待后端推送数据后再显示用户发送的消息。

1. **立即显示**：在前端通过 `setMessages` 立即添加一条带有 `isOptimistic: true` 标记的消息。
2. **防抖动合并**：当后端推送新的消息列表时，如果尚未包含刚才发送的消息（因为后端入库延迟），强制将本地的乐观消息拼接到列表末尾，防止消息“闪烁”消失。

## 6. 大列表渲染策略：先减轻 offscreen 压力，再考虑虚拟列表

当消息数量达到几千条时，即使所有计算都做到了缓存命中，浏览器仍然可能因为 layout/paint 压力出现卡顿。

### 6.1 content-visibility: auto（低成本收益）

对于消息列表这种“纵向长列表”，可以给每条 message 容器增加：

- `content-visibility: auto`

这能让浏览器跳过 offscreen 元素的渲染/布局（支持的浏览器会显著受益）。

对应实现位置：

- `src/components/MessageItem/MessageItem.tsx`：message 容器 style

注意事项：

- 建议配合 `contain-intrinsic-size` 提供占位尺寸，避免滚动时大幅跳动
- 该优化不改变数据结构，属于渲染层 “safe win”

### 6.2 什么时候需要虚拟列表（windowing）

如果仍然有明显卡顿，通常原因是：

- 每次 render 都要 `messages.map(...)` 创建几千个 React element（即使子项 memo 命中，父层也要做这部分工作）
- DOM 节点总量过大，滚动/重排成本高

此时应考虑 windowing（仅渲染 viewport 附近的一小段消息）。实现方式可以是自研轻量版，也可以引入成熟库（前提：依赖允许）。

## 7. 注意事项（易踩坑清单）

- **不要在循环里用数组展开做累积**：`arr = [...arr, ...next]` 对大段数据会退化成 O(n²) 拷贝。
- **WeakMap 缓存只对“引用稳定”有效**：如果 upstream 把 message/raw 每次都换成新对象，WeakMap 等于没缓存。
- **Map 缓存要管控生命周期**：Map 是强引用，必须：
  - 限制 size（例如超过阈值清空）
  - 在 session 切换时清空（避免跨会话堆积）
  - 在 i18n/localize 变化时清空（避免内容/过滤逻辑不一致）
- **useMemo / useCallback 不是银弹**：依赖数组一旦包含不稳定对象，缓存就会频繁失效；要优先保证依赖引用稳定。
- **避免让“输入框状态”牵连全局重渲染**：输入框尽量使用 uncontrolled/ref，提交逻辑推迟到下一帧。

## 8. 后续开发检查清单

在开发新功能或修改现有逻辑时，请检查以下几点：

- [ ] **引用检查**：如果你在 `useEffect` 或 `useMemo` 的依赖数组中放入了对象或数组，请确认它们的引用是否稳定。
- [ ] **大列表渲染**：对于像 `MessageList` 这样可能包含大量数据的列表，确保其子组件使用了 `React.memo`，且传递给子组件的 props（特别是回调函数和对象）是引用稳定的。
- [ ] **昂贵计算**：任何涉及文本解析、正则匹配的操作，都应该考虑是否需要缓存。
- [ ] **状态更新**：避免在高频回调（如 scroll、input）中直接更新 React 状态，考虑使用 `useRef` 或防抖（debounce）。
- [ ] **派生数据对象稳定性**：派生数组/对象（例如 mergedMessages）是否在输入不变时复用引用？否则下游缓存/渲染会反复被打穿。
- [ ] **算法复杂度审计**：任何“看起来只是拼数组/拼字符串”的逻辑，都要确认是否存在隐式的 O(n²) 拷贝。
- [ ] **缓存生命周期**：WeakMap vs Map 用对了吗？Map 是否限制 size 并在合适时机清空？
