// Demo data for _scene.mjs. A made-up todo-api project; nothing here comes from a real account.
const ROOT = '/work/todo-api'

const RATE_LIMIT = `import type { Request, Response, NextFunction } from 'express'

const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5
const attempts = new Map<string, number[]>()

export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now()
  const recent = (attempts.get(req.ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts' })
  }
  attempts.set(req.ip, [...recent, now])
  next()
}
`

function conversation({ title, ask, intro, testLabel, summary }) {
  const tool = (id, name, input) => ({
    type: 'assistant',
    content: '',
    raw: { uuid: `a-${id}`, message: { content: [{ type: 'tool_use', id, name, input }] } },
  })
  const result = (id, content) => ({
    type: 'user',
    content: '[tool_result]',
    raw: { uuid: `r-${id}`, message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } },
  })
  const text = (uuid, value) => ({
    type: 'assistant',
    content: value,
    raw: { uuid, message: { content: [{ type: 'text', text: value }] } },
  })
  return {
    title,
    messages: [
      { type: 'user', content: ask, raw: { uuid: 'u-1', message: { content: [{ type: 'text', text: ask }] } } },
      text('a-intro', intro),
      tool('read', 'Read', { file_path: `${ROOT}/src/routes/auth.ts` }),
      result('read', "router.post('/api/login', async (req, res) => {\n  const user = await login(req.body)\n  res.json(user)\n})"),
      tool('write', 'Write', { file_path: `${ROOT}/src/middleware/rateLimit.ts`, content: RATE_LIMIT }),
      result('write', 'File created successfully'),
      tool('edit', 'Edit', {
        file_path: `${ROOT}/src/routes/auth.ts`,
        old_string: "router.post('/api/login', async (req, res) => {",
        new_string: "router.post('/api/login', loginRateLimit, async (req, res) => {",
      }),
      result('edit', 'The file has been updated'),
      tool('edit-test', 'Edit', {
        file_path: `${ROOT}/test/auth.test.ts`,
        old_string: "describe('POST /api/login', () => {",
        new_string: [
          "describe('POST /api/login', () => {",
          "  it('returns 429 after 5 attempts in a minute', async () => {",
          '    for (let i = 0; i < 5; i++) await post(badLogin)',
          '    expect((await post(badLogin)).status).toBe(429)',
          '  })',
        ].join('\n'),
      }),
      result('edit-test', 'The file has been updated'),
      tool('test', 'Bash', { command: 'npm test -- auth', description: testLabel }),
      result('test', ' PASS  test/auth.test.ts\n  POST /api/login\n    ✓ logs in with a valid password (18 ms)\n    ✓ returns 429 after 5 attempts in a minute (9 ms)\n\nTests:  14 passed, 14 total'),
      text('a-summary', summary),
    ],
  }
}

const HOUR = 3_600_000
// Relative to capture time. Avoid 1-2h and 24-48h: English shows "1 hours ago" / "1 days ago".
const NOW = Date.now()
const ago = (hours) => new Date(NOW - hours * HOUR).toISOString()
const IDS = ['7c2e9a41', 'b81f0d36', '4e6a2c90', 'd03b7f15', '91ac4e68', '2f7d8b03', 'e5490c2a', '6b1d3f87']

function history(titles) {
  const sessions = titles.map(([title, hours, messageCount, isFavorited], index) => ({
    sessionId: `${IDS[index]}-4c1e-4b8a-9f3d-${String(index).padStart(12, '0')}`,
    title,
    lastTimestamp: ago(hours),
    messageCount,
    provider: 'claude',
    ...(isFavorited ? { isFavorited: true, favoritedAt: NOW - index } : {}),
  }))
  return {
    success: true,
    provider: 'claude',
    sessions,
    total: sessions.reduce((sum, s) => sum + s.messageCount, 0),
    favorites: Object.fromEntries(sessions.filter((s) => s.isFavorited).map((s) => [s.sessionId, { favoritedAt: s.favoritedAt }])),
  }
}

function codexThreads(rows) {
  return rows.map(([title, hours, messageCount], index) => ({
    id: `019a${IDS[index].slice(0, 4)}-7d2c-7e10-b3a9-${IDS[7 - index]}0c4d`,
    title,
    model: 'gpt-5.5',
    messageCount,
    updatedAt: ago(hours),
  }))
}

export const DEMO = {
  en: {
    conversation: conversation({
      title: 'Rate-limit the login endpoint',
      ask: 'Add rate limiting to POST /api/login (5 attempts per minute per IP) and cover it with a test.',
      intro: "I'll read the login route first, then add a small middleware so the route stays readable.",
      testLabel: 'Run the auth tests',
      summary:
        'Done. `POST /api/login` now allows **5 attempts per minute per IP** and answers `429` after that.\n\n- New middleware in `src/middleware/rateLimit.ts`\n- Wired into the login route\n- New test for the 429 case; all 14 auth tests pass',
    }),
    permission: {
      channelId: 'demo-permission',
      toolName: 'Bash',
      provider: 'claude',
      inputs: { cwd: 'todo-api', command: 'npm run db:migrate', description: 'Apply the new login_attempts migration' },
    },
    testLabel: 'Run the auth tests',
    codexThreads: codexThreads([
      ['Profile the slow /api/todos query', 2.5, 16],
      ['Add OpenAPI docs for the auth routes', 5, 11],
      ['Find why CI is red on main', 9, 27],
      ['Port the date helpers to Temporal', 52, 19],
      ['Draft a migration plan for Postgres 17', 78, 8],
      ['Remove the unused feature flags', 101, 13],
    ]),
    history: history([
      ['Rate-limit the login endpoint', 0.3, 14, true],
      ['Fix flaky date test in todo list', 3, 22],
      ['Explain the session refresh flow', 7, 9],
      ['Migrate settings page to React Query', 50, 41, true],
      ['Add CSV export to the reports view', 54, 18],
      ['Review PR #128: pagination cursor', 76, 12],
      ['Upgrade Express 4 to 5', 100, 33],
      ['Write release notes for v2.3', 122, 7],
    ]),
  },
  zh: {
    conversation: conversation({
      title: '给登录接口加限流',
      ask: '给 POST /api/login 加上限流（每个 IP 每分钟最多 5 次），并补一个测试。',
      intro: '我先看一下登录路由，再加一个小中间件，路由本身保持简洁。',
      testLabel: '运行 auth 测试',
      summary:
        '改好了。`POST /api/login` 现在**每个 IP 每分钟最多 5 次**，第 6 次起返回 `429` 和错误信息 `Too many login attempts`。\n\n- 新增中间件 `src/middleware/rateLimit.ts`\n- 接入登录路由\n- 补了 429 场景的测试，14 个 auth 测试全部通过',
    }),
    permission: {
      channelId: 'demo-permission',
      toolName: 'Bash',
      provider: 'claude',
      inputs: { cwd: 'todo-api', command: 'npm run db:migrate', description: '执行新增的 login_attempts 数据库迁移' },
    },
    testLabel: '运行 auth 测试',
    codexThreads: codexThreads([
      ['排查 /api/todos 查询慢的原因', 2.5, 16],
      ['给 auth 路由补 OpenAPI 文档', 5, 11],
      ['查一下 main 分支 CI 为什么挂了', 9, 27],
      ['日期工具函数改用 Temporal', 52, 19],
      ['起草 Postgres 17 迁移方案', 78, 8],
      ['清理不再使用的功能开关', 101, 13],
    ]),
    history: history([
      ['给登录接口加限流', 0.3, 14, true],
      ['修复待办列表里不稳定的日期测试', 3, 22],
      ['讲解会话刷新的流程', 7, 9],
      ['设置页迁移到 React Query', 50, 41, true],
      ['报表页增加 CSV 导出', 54, 18],
      ['审查 PR #128：分页游标', 76, 12],
      ['Express 4 升级到 5', 100, 33],
      ['撰写 v2.3 发布说明', 122, 7],
    ]),
  },
}
