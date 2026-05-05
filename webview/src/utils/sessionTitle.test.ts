import { describe, expect, it } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  getLatestMeaningfulRequirementText,
  getLatestMeaningfulRequirementTitle,
  isMeaningfulRequirementInput,
  summarizeRequirementTitle,
} from './sessionTitle';

const makeUserMessage = (content: string): ClaudeMessage => ({
  type: 'user',
  content,
  timestamp: new Date().toISOString(),
});

describe('sessionTitle', () => {
  it('prefers the latest meaningful requirement title', () => {
    const messages: ClaudeMessage[] = [
      makeUserMessage('请帮我修复这个报错并说明原因'),
      makeUserMessage('继续'),
      makeUserMessage('请把标签标题重命名成更清晰的短名称'),
    ];

    const title = getLatestMeaningfulRequirementTitle(messages, (message) => message.content || '');
    expect(title).toBe('请把标签标题重命名成');
  });

  it('returns latest meaningful requirement text without short-title compression', () => {
    const messages: ClaudeMessage[] = [
      makeUserMessage('请帮我修复这个报错并说明原因'),
      makeUserMessage('请把标签标题重命名成更清晰的短名称并支持超长省略'),
    ];

    const text = getLatestMeaningfulRequirementText(messages, (message) => message.content || '');
    expect(text).toBe('请把标签标题重命名成更清晰的短名称并支持超长省略');
  });

  it('ignores continue-like or short inputs', () => {
    const messages: ClaudeMessage[] = [
      makeUserMessage('继续'),
      makeUserMessage('下一步'),
      makeUserMessage('改一下'),
    ];

    const title = getLatestMeaningfulRequirementTitle(messages, (message) => message.content || '');
    expect(title).toBeNull();
  });

  it('ignores synthetic [tool_result] user messages', () => {
    const messages: ClaudeMessage[] = [
      makeUserMessage('请帮我修复这个报错并解释原因'),
      makeUserMessage('[tool_result]'),
    ];

    const title = getLatestMeaningfulRequirementTitle(messages, (message) => message.content || '');
    expect(title).toBe('请帮我修复这个报错并');
  });

  it('filters path-like noise before meaningful-length check', () => {
    const onlyPath = 'file:///C:/Users/demo/Desktop/a/b/c.png';
    const mixed = '把这个路径引用改成配置化 file:///C:/Users/demo/Desktop/a/b/c.png';

    expect(isMeaningfulRequirementInput(onlyPath)).toBe(false);
    expect(isMeaningfulRequirementInput(mixed)).toBe(true);
    expect(summarizeRequirementTitle(mixed).length).toBeGreaterThan(0);
  });

  it('uses first sentence and trims to 10 chars', () => {
    expect(summarizeRequirementTitle('你对我的约束是什么')).toBe('你对我的约束是什么');
    expect(summarizeRequirementTitle('如果没有全显示完的话你就要打...那3个点省略号')).toBe('如果没有全显示完的话');
    expect(summarizeRequirementTitle('写一下cc-gui的说明文档 放在这个目录里')).toBe('写一下cc-gui的');
    expect(summarizeRequirementTitle('你好')).toBe('你好');
    expect(summarizeRequirementTitle('这是一个非常非常长并且没有明显关键词的需求描述')).toHaveLength(10);
  });

  it('extracts label value when first sentence starts with 需求简述', () => {
    expect(summarizeRequirementTitle('需求简述:改重命名逻辑\n然后继续写实现')).toBe('改重命名逻辑');
    expect(summarizeRequirementTitle('需求简述：把标签名改成第一句摘要')).toBe('把标签名改成第一句摘');
  });
});
