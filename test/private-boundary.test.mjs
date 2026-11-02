import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installPrivateBoundary } from '../src/private-boundary.mjs'

test('directory changes and relative file/search paths use the effective DSH working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'feishu-cwd-'))
  const workspace = join(root, 'workspace'), subdir = join(workspace, 'sub'), privateDir = join(root, 'state')
  try {
    await mkdir(subdir, { recursive: true }); await mkdir(privateDir)
    await symlink(privateDir, join(workspace, 'private-link'), 'dir')
    let gate, cwd = subdir
    const ctx = {
      workingDirectory: { get: () => cwd },
      effect: fn => fn(),
      on: (_, fn) => { gate = fn; return () => {} },
      shellEnv: { register() {} },
    }
    installPrivateBoundary(ctx, { config: { workspace }, bridge: { runningForAgent: () => undefined } })
    const check = (name, args) => gate({ name, arguments: args, agent: { session: { header: { cwd: workspace } } } }, async () => ({ kind: 'allow' }))
    assert.equal((await check('working_directory', { cd: '..' })).kind, 'allow')
    assert.equal((await check('working_directory', {})).kind, 'allow')
    for (const cd of ['../..', privateDir, '../private-link']) assert.equal((await check('working_directory', { cd })).kind, 'deny')
    assert.equal((await check('working_directory', { cd: '../private-link/..' })).kind, 'deny')
    assert.equal((await check('working_directory', { cd: '../missing/..' })).kind, 'deny')
    for (const name of ['read', 'read_image', 'write', 'edit']) {
      assert.equal((await check(name, { file_path: '../result.txt' })).kind, 'allow')
      assert.equal((await check(name, { file_path: '../../state/secret.txt' })).kind, 'deny')
      assert.equal((await check(name, { file_path: '../private-link/../secret.txt' })).kind, 'deny')
    }
    // A restored Session can carry a directory different from its original header.
    cwd = privateDir
    assert.equal((await check('read', { file_path: 'secret.txt' })).kind, 'deny')
    for (const name of ['glob', 'grep']) assert.equal((await check(name, {})).kind, 'deny')
    assert.equal((await gate({ name: 'read', arguments: { file_path: 'result.txt' } }, async () => ({ kind: 'allow' }))).kind, 'allow')
  } finally { await rm(root, { recursive: true, force: true }) }
})
