// Writes one page per illustration and language from the table below; render.mjs turns them into WebP.
//   node docs/illustrations/_build.mjs
// Crop coordinates are CSS px of the 600x900 captures in shots/<lang>/ (see _scene.mjs).
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = dirname(fileURLToPath(import.meta.url))
const LANGS = ['en', 'zh']
const SHOT = { w: 600, h: 900 }

const PAGES = [
  {
    slug: '01-hero',
    tint: 'blue',
    tall: true,
    copy: {
      en: {
        eyebrow: 'CC GUI · JetBrains plugin',
        headline: 'Many AI coding CLIs,<br />one IDE panel',
        lede: 'Pick the CLI for each session right from the input box: <span class="nowrap">Claude Code</span>, Codex, Grok, Kimi, OpenCode, DeepSeek and more. Chat, tool calls and file edits stay inside the IDE.',
      },
      zh: {
        eyebrow: 'CC GUI · JetBrains 插件',
        headline: '多个 AI 编程 CLI，<br />一个 IDE 面板',
        lede: '在输入框里就能给每个会话选 CLI：<span class="nowrap">Claude Code</span>、Codex、Grok、Kimi、OpenCode、DeepSeek 等。对话、工具调用和<span class="nowrap">文件改动</span>都在 IDE 里完成。',
      },
    },
    crops: [
      { shot: 'chat', x: 0, y: 0, w: 600, h: 482, k: 0.85, left: 0, top: 40 },
      // The input box from the chat, with the CLI menu laid back over it at its real offset (40, -213).
      { shot: 'chat', x: 9, y: 726, w: 583, h: 166, k: 1, left: 92, top: 470, radius: 8 },
      { shot: 'menu', x: 49, y: 513, w: 200, h: 340, k: 1, left: 132, top: 257, radius: 6, zh: { y: 512, h: 341, top: 256 } },
    ],
  },
  {
    slug: '02-changes',
    tint: 'green',
    copy: {
      en: {
        eyebrow: 'Edits',
        headline: 'See every file<br />the agent touched',
        lede: 'Each edit shows up as a card with its line counts. The Edits panel sums up the whole session: open a diff, undo one file, or Keep All / Discard All.',
      },
      zh: {
        eyebrow: '文件改动',
        headline: 'AI 改了哪些文件，<br />一眼看清',
        lede: '每次改动都是一张卡片，带增删行数。底部的<span class="nowrap">“编辑”面板</span>汇总整个会话：逐个看 diff、撤销单个文件，或者一键保存全部、回撤全部。',
      },
    },
    crops: [
      { shot: 'changes', x: 15, y: 109, w: 571, h: 397, k: 0.85, left: 0, top: 30 },
      { shot: 'changes', x: 21, y: 520, w: 559, h: 188, k: 1, left: 116, top: 358, radius: 8, zh: { y: 516, h: 192 } },
    ],
  },
  {
    slug: '03-permission',
    tint: 'peach',
    copy: {
      en: {
        eyebrow: 'Permissions',
        headline: 'Nothing runs<br />until you say so',
        lede: 'In Default mode, commands and file writes wait for you: Allow Once, Always Allow, or Deny. Switch to Plan, Agent, Auto or Full Auto when you trust the task.',
      },
      zh: {
        eyebrow: '权限审批',
        headline: '执行之前，<br />先问过你',
        lede: '默认模式下，命令和写文件都要你点头：允许一次、总是允许或拒绝。信得过的任务，可以切到规划、代理、自动审批或全自动模式。',
      },
    },
    crops: [
      { shot: 'modes', x: 79, y: 633, w: 464, h: 220, k: 1, left: 0, top: 72, radius: 6, zh: { y: 608, w: 309, h: 245, top: 56 } },
      { shot: 'permission', x: 0, y: 678, w: 600, h: 222, k: 0.95, left: 100, top: 318, radius: 12, zh: { y: 675, h: 225 } },
    ],
  },
  {
    slug: '04-history',
    tint: 'sky',
    copy: {
      en: {
        eyebrow: 'History',
        headline: 'Every CLI keeps<br />its own history',
        lede: 'Reopen past sessions from <span class="nowrap">Claude Code</span>, Codex and the rest. Search by title and star the ones you come back to; starred sessions stay on top.',
      },
      zh: {
        eyebrow: '历史会话',
        headline: '每个 CLI 的<br />历史会话都在',
        lede: '<span class="nowrap">Claude Code</span>、Codex 等 CLI 的历史会话都能找回来接着聊。可以按标题搜索，常用的加星标，星标会话排在最前面。',
      },
    },
    crops: [
      {
        shot: 'history', x: 12, y: 50, w: 578, h: 374, k: 0.88, left: 6, top: 92, rotate: -5,
        label: { icon: 'claude-code', text: 'Claude Code', left: 10, top: 36 },
      },
      {
        shot: 'history-codex', x: 12, y: 50, w: 578, h: 374, k: 0.88, left: 168, top: 214,
        label: { icon: 'codex', text: 'Codex', left: 568, top: 160 },
      },
    ],
  },
]

const varName = (shot) => `--${shot}`

function shotVars(page, lang) {
  const shots = [...new Set(page.crops.map((crop) => crop.shot))]
  const block = (theme) => shots.map((shot) => `${varName(shot)}: url(shots/${lang}/${shot}-${theme}.png);`).join(' ')
  return `:root { ${block('light')} }\n      @media (prefers-color-scheme: dark) { :root { ${block('dark')} } }`
}

function cropHtml(base, lang) {
  // Per-language overrides: the Chinese UI lays out some popovers at other sizes.
  const crop = { ...base, ...base[lang] }
  const style = [
    `--shot: var(${varName(crop.shot)})`,
    `--x: ${crop.x}px`, `--y: ${crop.y}px`, `--w: ${crop.w}px`, `--h: ${crop.h}px`, `--k: ${crop.k}`,
    `left: ${crop.left}px`, `top: ${crop.top}px`,
    crop.radius ? `border-radius: ${crop.radius}px` : '',
    crop.rotate ? `transform: rotate(${crop.rotate}deg); transform-origin: top left` : '',
  ].filter(Boolean).join('; ')
  const label = crop.label
    ? `<span class="crop-label" style="position: absolute; left: ${crop.label.left}px; top: ${crop.label.top}px${crop.rotate ? `; transform: rotate(${crop.rotate}deg)` : ''}"><i class="mark" style="--icon: url(icons/${crop.label.icon}.svg)"></i>${crop.label.text}</span>\n        `
    : ''
  return `${label}<div class="crop" style="${style}"></div>`
}

function pageHtml(page, lang) {
  const copy = page.copy[lang]
  return `<!doctype html>
<!-- Generated by _build.mjs; edit the table there. -->
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="base.css" />
    <style>
      ${shotVars(page, lang)}
      .crop { --shot-w: ${SHOT.w}px; --shot-h: ${SHOT.h}px; }
    </style>
  </head>
  <body>
    <div id="canvas" data-tint="${page.tint}"${page.tall ? ' class="tall"' : ''}>
      <div class="copy">
        <span class="eyebrow">${copy.eyebrow}</span>
        <h2 class="headline">${copy.headline}</h2>
        <p class="lede">${copy.lede}</p>
      </div>
      <div class="stage">
        ${page.crops.map((crop) => cropHtml(crop, lang)).join('\n        ')}
      </div>
    </div>
  </body>
</html>
`
}

for (const lang of LANGS) {
  for (const page of PAGES) {
    const file = join(DIR, `${page.slug}-${lang}.html`)
    writeFileSync(file, pageHtml(page, lang))
    console.log(file)
  }
}
