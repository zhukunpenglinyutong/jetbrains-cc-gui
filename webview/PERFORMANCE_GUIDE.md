# Webview 性能优化指南

本文档记录了我们在优化聊天界面性能时的关键发现和解决方案，旨在为后续开发提供指导，避免类似的性能瓶颈再次出现。

## 1. 核心问题：对象引用稳定性 (Object Identity Stability)

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

## 3. UI 响应性优化

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

## 4. 后续开发检查清单

在开发新功能或修改现有逻辑时，请检查以下几点：

- [ ] **引用检查**：如果你在 `useEffect` 或 `useMemo` 的依赖数组中放入了对象或数组，请确认它们的引用是否稳定。
- [ ] **大列表渲染**：对于像 `MessageList` 这样可能包含大量数据的列表，确保其子组件使用了 `React.memo`，且传递给子组件的 props（特别是回调函数和对象）是引用稳定的。
- [ ] **昂贵计算**：任何涉及文本解析、正则匹配的操作，都应该考虑是否需要缓存。
- [ ] **状态更新**：避免在高频回调（如 scroll、input）中直接更新 React 状态，考虑使用 `useRef` 或防抖（debounce）。

---
*Created by Trae AI Assistant*
