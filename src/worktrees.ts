import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface Worktree {
  path: string
  branch: string
}

/** Cria um git worktree isolado para um subagente, fora do repositorio principal, em branch propria. */
export function createWorktree(home: string, workspace: string, runId: string): Worktree {
  const root = git(workspace, ['rev-parse', '--show-toplevel']).trim()
  const short = runId.slice(0, 8)
  const branch = `agent/${short}`
  const dir = join(home, 'worktrees', basename(root))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, short)
  if (!existsSync(path)) git(root, ['worktree', 'add', '--quiet', '-b', branch, path, 'HEAD'])
  return { path, branch }
}

export function listWorktrees(workspace: string): string {
  return git(workspace, ['worktree', 'list'])
}

export function isGitRepo(workspace: string): boolean {
  try {
    git(workspace, ['rev-parse', '--is-inside-work-tree'])
    return true
  } catch {
    return false
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
