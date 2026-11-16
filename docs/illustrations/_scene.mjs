// Screenshots for the README illustrations: the real webview in a browser, fed demo data
// through the same window.sendToJava mock the Playwright E2E suite uses.
//
//   cd webview && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4795
//   UI_LANG=en node <skill>/scripts/capture.mjs docs/illustrations/_scene.mjs --out docs/illustrations/shots/en
//   UI_LANG=zh node <skill>/scripts/capture.mjs docs/illustrations/_scene.mjs --out docs/illustrations/shots/zh
import { DEMO } from './_demo-data.mjs'

const LANG = process.env.UI_LANG === 'zh' ? 'zh' : 'en'
const data = DEMO[LANG]

export const url = `http://127.0.0.1:${process.env.VITE_PORT ?? 4795}/`
export const viewport = { width: 600, height: 900 }
export const locale = LANG === 'zh' ? 'zh-CN' : 'en-US'

/** Runs in the page before the app mounts. */
function installBridge({ lang, history, codexThreads }) {
  localStorage.setItem('language', lang)
  localStorage.setItem('lastSeenChangelogVersion', '99.0.0')
  localStorage.setItem('openSourceBannerDismissed', 'true')
  window.__INITIAL_IDE_THEME__ = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const reply = (name, payload) => setTimeout(() => window[name]?.(JSON.stringify(payload)), 0)
  window.sendToJava = (message) => {
    if (message.startsWith('get_dependency_status')) {
      reply('updateDependencyStatus', {
        'claude-sdk': { status: 'installed', meetsMinimumVersion: true },
        'codex-sdk': { status: 'installed', meetsMinimumVersion: true },
      })
    }
    if (message.startsWith('load_history_data')) {
      setTimeout(() => window.setHistoryData?.(history), 0)
    }
    if (message.startsWith('codex_native_list_threads:')) {
      const { requestId } = JSON.parse(message.slice('codex_native_list_threads:'.length))
      reply('onCodexNativeData', {
        requestType: 'codex_native_list_threads', requestId, source: 'native',
        data: codexThreads, total: codexThreads.length, nextCursor: null,
      })
    }
  }
}

async function reload(page) {
  await page.reload()
  await page.locator('.input-editable').waitFor()
  await page.addStyleTag({ content: '#__vconsole { display: none !important; }' })
}

export async function setup(page) {
  await page.addInitScript(installBridge, { lang: LANG, history: data.history, codexThreads: data.codexThreads })
  await reload(page)
}

async function loadConversation(page, messages) {
  await page.evaluate((list) => {
    window.setSessionId?.('demo-session')
    window.updateMessages?.(JSON.stringify(list.messages))
    window.updateSessionTitle?.('demo-session', list.title)
  }, messages)
  // The list renders the latest turn first and fills in earlier items afterwards.
  await page.locator('.message.user').first().waitFor()
  await page.locator('.message.assistant').getByText(messages.messages[1].content).waitFor()
  await page.waitForTimeout(800)
}

async function openHistory(page) {
  await page.locator('.header .codicon-history').first().click()
  await page.locator('.history-search-input').waitFor()
  await page.waitForTimeout(500)
}

export const shots = [
  // hero, back: a finished turn
  { name: 'chat', prepare: (page) => loadConversation(page, data.conversation) },
  {
    // hero, front: the CLI menu over an empty chat, so nothing busy shows beside it
    name: 'menu',
    async prepare(page) {
      await page.locator('.button-area-left .selector-button').nth(1).click()
      await page.locator('[data-provider-id="codex"]').waitFor()
    },
  },
  {
    name: 'changes',
    async prepare(page) {
      await loadConversation(page, data.conversation)
      await page.getByText(data.testLabel, { exact: true }).click()
      await page.locator('.status-panel-tab:has(.codicon-edit)').click()
      await page.waitForTimeout(400)
      // Pin the command card's bottom at y=503 so both languages share crop coordinates.
      await page.locator('.bash-tool-header').evaluate((header) => {
        const card = header.closest('.task-container')
        let scroller = card.parentElement
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
        scroller.scrollTop += card.getBoundingClientRect().bottom - 503
      })
      await page.waitForTimeout(300)
    },
  },
  {
    name: 'permission',
    async prepare(page) {
      await loadConversation(page, data.conversation)
      await page.evaluate((request) => window.showPermissionDialog?.(JSON.stringify(request)), data.permission)
      await page.locator('.permission-dialog-v3').waitFor()
    },
  },
  {
    name: 'modes',
    async prepare(page) {
      await page.locator('.button-area-left .selector-button').nth(2).click()
      await page.locator('.selector-dropdown').waitFor()
    },
  },
  { name: 'history', prepare: openHistory },
  {
    name: 'history-codex',
    async prepare(page) {
      // Switching in the menu asks the IDE for a new session, which the mock cannot answer; start in Codex instead.
      await page.evaluate(() => localStorage.setItem('model-selection-state', JSON.stringify({ provider: 'codex' })))
      await reload(page)
      await page.locator('.button-area[data-provider="codex"]').first().waitFor()
      await openHistory(page)
    },
  },
]
