import { copyToClipboard } from '../../utils/helpers';

interface SkillHelpDialogProps {
  onClose: () => void;
}

/**
 * Skills 帮助弹窗
 * 解释什么是 Skills 以及如何使用
 */
export function SkillHelpDialog({ onClose }: SkillHelpDialogProps) {
  // 阻止事件冒泡
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // 复制链接并提示
  const handleLinkClick = async (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    const success = await copyToClipboard(url);
    if (success) {
      alert('链接已复制，请在浏览器中打开');
    }
  };

  return (
    <div className="skill-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="skill-dialog help-dialog">
        {/* 标题栏 */}
        <div className="dialog-header">
          <h3>什么是 Skills?</h3>
          <button className="close-btn" onClick={onClose}>
            <span className="codicon codicon-close"></span>
          </button>
        </div>

        {/* 内容 */}
        <div className="dialog-content help-content">
          <section className="help-section">
            <h4>
              <span className="codicon codicon-extensions"></span>
              概述
            </h4>
            <p>
              Skills 是 Claude 动态加载的指令、脚本和资源文件夹，用于提升特定任务的表现。
              Skills 可以教会 Claude 以可重复的方式完成特定任务，比如使用公司品牌指南创建文档、
              按照组织特定的工作流分析数据，或自动化个人任务。
            </p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-folder"></span>
              Skill 结构
            </h4>
            <p>一个 Skill 是包含 <code>SKILL.md</code> 文件的文件夹：</p>
            <pre className="code-block">
{`my-skill/
├── SKILL.md          # 必须：技能定义文件
├── templates/        # 可选：模板文件
└── references/       # 可选：参考资料`}
            </pre>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-file-code"></span>
              SKILL.md 格式
            </h4>
            <p>SKILL.md 文件使用 YAML frontmatter + Markdown 格式：</p>
            <pre className="code-block">
{`---
name: my-skill-name
description: 技能描述和使用时机
---

# 技能指令

详细的指令内容...`}
            </pre>
            <p className="hint-text">
              <code>name</code> 和 <code>description</code> 是必填字段，
              可选字段包括 <code>license</code>、<code>allowed-tools</code>、<code>metadata</code>
            </p>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-gear"></span>
              配置方式
            </h4>
            <p>添加 Skill 的方式：</p>
            <ul>
              <li>
                <strong>本地路径</strong>：指定包含 <code>SKILL.md</code> 的文件夹路径
              </li>
              <li>
                <strong>相对路径</strong>：相对于项目根目录，如 <code>./skills/my-skill</code>
              </li>
              <li>
                <strong>绝对路径</strong>：完整的文件系统路径
              </li>
            </ul>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-lightbulb"></span>
              使用提示
            </h4>
            <ul>
              <li>确保 Skill 目录包含有效的 <code>SKILL.md</code> 文件</li>
              <li>Skill 名称必须使用小写字母、数字和连字符（hyphen-case）</li>
              <li>Skill 加载后会在 Claude 会话中自动生效</li>
              <li>可以通过启用/禁用开关控制单个 Skill 的状态</li>
              <li>在聊天中提及 Skill 名称即可使用，如："使用 pdf skill 提取表单字段"</li>
            </ul>
          </section>

          <section className="help-section">
            <h4>
              <span className="codicon codicon-link-external"></span>
              了解更多
            </h4>
            <p>更多关于 Skills 的信息：</p>
            <ul>
              <li>
                <a
                  href="https://support.claude.com/en/articles/12512176-what-are-skills"
                  onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512176-what-are-skills')}
                >
                  什么是 Skills?
                </a>
              </li>
              <li>
                <a
                  href="https://support.claude.com/en/articles/12512198-creating-custom-skills"
                  onClick={(e) => handleLinkClick(e, 'https://support.claude.com/en/articles/12512198-creating-custom-skills')}
                >
                  如何创建自定义 Skills
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/anthropics/skills"
                  onClick={(e) => handleLinkClick(e, 'https://github.com/anthropics/skills')}
                >
                  Anthropic Skills 示例仓库
                </a>
              </li>
            </ul>
          </section>
        </div>

        {/* 底部按钮 */}
        <div className="dialog-footer">
          <button className="btn-primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
