import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export async function workspacePath(path, workspace, cwd = workspace) {
  if (typeof path !== 'string') return false
  // DSH's POSIX filesystem follows symlinks before traversing "..". Lexical
  // normalization here could admit a path whose physical target is private.
  let actual = process.platform === 'win32' ? resolve(cwd, path) : isAbsolute(path) ? path : `${cwd}${sep}${path}`
  for (;;) {
    try { actual = await realpath(actual); break } catch (e) { if (e.code !== 'ENOENT' || basename(actual) === '..') return false; const parent = dirname(actual); if (parent === actual) return false; actual = parent }
  }
  const p = relative(await realpath(workspace), actual)
  return p === '' || !p.startsWith('..') && !isAbsolute(p)
}

export function installPrivateBoundary(ctx, { config, bridge, attachments }) {
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const args = exec.arguments ?? {}
    const session = exec.agent?.session
    const cwd = (session && ctx.workingDirectory?.get(session)) ?? session?.header?.cwd ?? config.workspace
    if (exec.name === 'working_directory' && args.cd !== undefined && !await workspacePath(args.cd, config.workspace, cwd)) return { kind: 'deny', reason: '只能切换到业务工作区内的目录。' }
    if (['glob', 'grep'].includes(exec.name) && !await workspacePath(args.path ?? cwd, config.workspace, cwd)) return { kind: 'deny', reason: '搜索只限业务工作区；' }
    if (['read', 'read_image', 'write', 'edit'].includes(exec.name)) {
      const permitted = await workspacePath(args.file_path, config.workspace, cwd)
      const turn = bridge.runningForAgent(exec.agent)
      const attachment = ['read', 'read_image'].includes(exec.name) && (turn?.allowedFiles ?? []).includes(args.file_path)
      if (!permitted && !attachment) return { kind: 'deny', reason: '只能访问业务工作区和当前会话附件；' }
    }
    if (exec.name === 'bash' && args.sandbox_permissions !== undefined && !['workspace-write', 'read-only'].includes(args.sandbox_permissions)) return { kind: 'deny', reason: '业务会话禁止绕过上下文隔离运行器。' }
    if (['run_code', 'pwsh', 'cordis', 'ask_user_question', 'set_permissions', 'enter_plan_mode', 'exit_plan_mode'].includes(exec.name) || /plugin|terminal|permission|cordis|^session_/.test(exec.name)) return { kind: 'deny', reason: '本部署使用业务工具或隔离 bash；追问请发送文字并等待下一条飞书消息。' }
    return next()
  }, { prepend: true }), 'Feishu private state boundary')
  ctx.shellEnv.register({ name: 'feishu-current-attachments', variables: { [config.attachmentEnvironment ?? 'DSH_FEISHU_ALLOWED_FILES']: { description: 'Runtime-attested attachment files for the current conversation sandbox' } }, resolve(exec) { return { [config.attachmentEnvironment ?? 'DSH_FEISHU_ALLOWED_FILES']: JSON.stringify(bridge.runningForAgent(exec.agent)?.allowedFiles ?? []) } } })
}
