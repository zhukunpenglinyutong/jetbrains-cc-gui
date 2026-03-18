#!/usr/bin/env node
import { execSync } from 'child_process'
import readline from 'readline'

/**
 * Build a global PID -> PPID map from all system processes.
 * Used to trace ancestor chains for grouping.
 */
function getPpidMap() {
  const output = execSync('ps -eo pid,ppid', { encoding: 'utf-8' })
  const map = new Map()
  for (const line of output.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2) {
      const pid = parseInt(parts[0])
      const ppid = parseInt(parts[1])
      if (!isNaN(pid) && !isNaN(ppid)) map.set(pid, ppid)
    }
  }
  return map
}

/**
 * Walk up the PPID chain (max 5 levels) to find an ancestor daemon.
 */
function findAncestorDaemon(pid, daemonPids, ppidMap) {
  let current = pid
  for (let i = 0; i < 5; i++) {
    const parent = ppidMap.get(current)
    if (!parent || parent === current || parent <= 1) return null
    if (daemonPids.has(parent)) return parent
    current = parent
  }
  return null
}

/**
 * Batch-fetch working directories for a list of PIDs via lsof.
 * Returns Map<pid, directoryPath>.
 */
function getWorkingDirs(pids) {
  if (pids.length === 0) return new Map()
  try {
    const output = execSync(
      `lsof -a -d cwd -p ${pids.join(',')} -Fpn 2>/dev/null`,
      { encoding: 'utf-8' }
    )
    const map = new Map()
    let currentPid = null
    for (const line of output.split('\n')) {
      if (line.startsWith('p')) currentPid = parseInt(line.slice(1))
      else if (line.startsWith('n') && currentPid) map.set(currentPid, line.slice(1))
    }
    return map
  } catch {
    return new Map()
  }
}

/**
 * Extract a short project name from a full directory path.
 * e.g. "/Users/zhu/Desktop/idea-claude-code-gui" -> "idea-claude-code-gui"
 */
function extractProjectName(dir) {
  if (!dir || dir === '/') return ''
  // Strip trailing slash and get last component
  const parts = dir.replace(/\/+$/, '').split('/')
  const name = parts[parts.length - 1]
  // Skip home directory or generic names
  if (['/', '.', '~', 'Desktop', 'Documents', 'Home'].includes(name)) return ''
  return name
}

function getProcesses() {
  const output = execSync('ps -eo pid,ppid,pcpu,start,command', { encoding: 'utf-8' })
  const lines = output.split('\n').slice(1)

  const processes = []
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.trim().split(/\s+/)
    const pid = parseInt(parts[0])
    const ppid = parseInt(parts[1])
    const cpu = parseFloat(parts[2])
    const startTime = parts[3]
    const command = parts.slice(4).join(' ')

    const isClaude = /\/claude(\s|$)/.test(command) || /^\s*claude\s*$/.test(command)
    const isDaemon = command.includes('idea-claude-code-gui') && command.includes('daemon.js')
    const isStreamJson = command.includes('--output-format stream-json')
    const isMcp = command.includes('mcp-server') || command.includes('mcp_server')

    if (!isClaude && !isDaemon && !isStreamJson) continue

    // Exclude MCP plugin processes
    if (isMcp) continue

    // Exclude system daemons (cloudd, cfprefsd, etc.)
    if (command.includes('cloudd') || command.includes('cfprefsd')) continue

    let type = '未知'
    if (isStreamJson) type = 'Claude 子进程 (IDE)'
    else if (isClaude) type = 'Claude 会话'
    else if (isDaemon) type = 'Daemon 守护进程'

    processes.push({ pid, ppid, cpu, startTime, type, command: command.slice(0, 80) })
  }

  return processes
}

function printTree(processes) {
  if (processes.length === 0) {
    console.log('\n  没有找到 Claude 相关进程。\n')
    return
  }

  const ppidMap = getPpidMap()
  const cwdMap = getWorkingDirs(processes.map(p => p.pid))

  const daemons = processes.filter(p => p.type === 'Daemon 守护进程')
  const nonDaemons = processes.filter(p => p.type !== 'Daemon 守护进程')
  const daemonPids = new Set(daemons.map(d => d.pid))

  // Group non-daemon processes by ancestor daemon
  const grouped = new Map()
  const independent = []

  for (const p of nonDaemons) {
    const ancestorPid = findAncestorDaemon(p.pid, daemonPids, ppidMap)
    if (ancestorPid !== null) {
      if (!grouped.has(ancestorPid)) grouped.set(ancestorPid, [])
      grouped.get(ancestorPid).push(p)
    } else {
      independent.push(p)
    }
  }

  console.log('')

  // Print daemon groups
  for (const daemon of daemons) {
    const children = grouped.get(daemon.pid) || []
    const project = extractProjectName(cwdMap.get(daemon.pid))
    const projectTag = project ? `, 项目: ${project}` : ''
    console.log(`  Daemon [PID: ${daemon.pid}, 启动: ${daemon.startTime}${projectTag}]`)
    if (children.length === 0) {
      console.log(`    (无子进程)`)
    } else {
      for (let i = 0; i < children.length; i++) {
        const c = children[i]
        const isLast = i === children.length - 1
        const status = c.cpu > 0.5 ? '对话中' : '空闲'
        console.log(`    ${isLast ? '└─' : '├─'} ${c.type} [PID: ${c.pid}] ${status}`)
      }
    }
    console.log('')
  }

  // Print independent processes
  if (independent.length > 0) {
    console.log(`  独立进程 (终端会话等)`)
    for (let i = 0; i < independent.length; i++) {
      const p = independent[i]
      const isLast = i === independent.length - 1
      const status = p.cpu > 0.5 ? '对话中' : '空闲'
      const project = extractProjectName(cwdMap.get(p.pid))
      const projectTag = project ? ` @ ${project}` : ''
      console.log(`    ${isLast ? '└─' : '├─'} ${p.type} [PID: ${p.pid}] ${status}${projectTag}`)
    }
    console.log('')
  }

  console.log(`  共 ${processes.length} 个进程\n`)
}

function killProcesses(pids) {
  let killed = 0
  let failed = 0
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
      killed++
    } catch {
      failed++
    }
  }
  console.log(`\n  已关闭 ${killed} 个进程` + (failed > 0 ? `，${failed} 个失败` : '') + '\n')
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()) }))
}

// --- Main flow ---
console.log('\n  Claude 进程管理工具')
console.log('  ==================\n')

const processes = getProcesses()
printTree(processes)

if (processes.length === 0) process.exit(0)

const answer = await ask('  要关闭这些进程吗？(y=全部关闭 / n=不关闭 / 输入PID用逗号隔开): ')

if (answer.toLowerCase() === 'y') {
  killProcesses(processes.map(p => p.pid))
} else if (answer.toLowerCase() === 'n') {
  console.log('\n  已取消。\n')
} else {
  const pids = answer.split(/[,\s]+/).map(Number).filter(n => !isNaN(n) && n > 0)
  if (pids.length > 0) {
    killProcesses(pids)
  } else {
    console.log('\n  无效输入，已取消。\n')
  }
}

// Check again after closing processes
const remaining = getProcesses()
if (remaining.length > 0) {
  console.log('  关闭后剩余进程:')
  printTree(remaining)
}
