import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

export const mainTools = ['read', 'read_image', 'glob', 'grep', 'working_directory', 'skill', 'orchestrator_delegate', 'send_message', 'orchestrator_tasks', 'orchestrator_cancel']
// Execution agents inherit installed capabilities. Keep channel output and
// frontdesk control at the parent, instead of maintaining an incomplete allowlist.
export const workerDeniedTools = ['message', 'send_wechat', 'send_feishu', 'feishu_send_message', 'ask_user_question']
export const permitsTool = (role, name) => role.kind === 'frontdesk'
  ? mainTools.includes(name)
  : !workerDeniedTools.includes(name) && !name.startsWith('orchestrator_')

// Match DSH's physical path traversal, including symlink/.. and new files.
// This is a tool boundary in a trusted process, not an OS sandbox.
export function insideWorkspace(path, workspace, cwd = workspace) {
  if (typeof path !== 'string' || !path) return false
  let actual = isAbsolute(path) ? path : `${cwd}${sep}${path}`
  for (;;) {
    try { actual = realpathSync.native(actual); break }
    catch (error) {
      if (error.code !== 'ENOENT' || basename(actual) === '..') return false
      const parent = dirname(actual)
      if (parent === actual) return false
      actual = parent
    }
  }
  try {
    const rel = relative(realpathSync.native(workspace), actual)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  } catch { return false }
}

export function denial(ctx, role, exec) {
  if (role.revoked || role.root.revoked || role.root.suspended) return '当前任务已停止，工具权限已撤销。'
  if (!permitsTool(role, exec.name)) return role.kind === 'frontdesk'
    ? '该执行工具属于子代理。请调用 orchestrator_delegate 委派任务；主会话工具目录不代表子代理能力，不能据此报告环境缺少工具。'
    : '此角色未开放该工具；面向用户的沟通由主会话负责。'
  // Workers use the host's normal permissions/approvals. This plugin only
  // constrains frontdesk paths; it is not an OS sandbox for executable tools.
  if (role.kind === 'worker') return
  const args = exec.arguments ?? {}
  const cwd = ctx.workingDirectory.get(exec.agent.session) ?? role.workspace
  let path
  if (['read', 'read_image', 'write', 'edit'].includes(exec.name)) path = args.file_path
  else if (['glob', 'grep'].includes(exec.name)) path = args.path ?? cwd
  else if (exec.name === 'working_directory' && args.cd !== undefined) path = args.cd
  else return
  if (insideWorkspace(path, role.workspace, cwd)) return
  if (['read', 'read_image'].includes(exec.name) && role.allowedFiles.has(path)) return
  return '只能访问任务工作区和通道实际交接的附件。'
}
