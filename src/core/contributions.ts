/** Local-only, manually invoked staging of reviewed text patches. Never runs project code. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rmdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SynapseError, type RunRecord } from './types.ts';

export interface PatchContract { baseCommit: string; paths: string[] }
export function validatePatchContract(value: PatchContract): void {
  if (!value || !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value.baseCommit) || !Array.isArray(value.paths) || !value.paths.length || value.paths.length > 32)
    throw new SynapseError('Patch requires a full Git commit and 1–32 explicit paths');
  for (const path of value.paths) {
    if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_. /-]*$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || /^\.git/i.test(p) || /^\.opencode$/i.test(p) || /^\.env/i.test(p)))
      throw new SynapseError('Invalid or protected patch path');
  }
  if (new Set(value.paths).size !== value.paths.length) throw new SynapseError('Duplicate patch paths');
}
export function extractPatch(text: string): string {
  const matches = [...text.matchAll(/^```diff\s*\r?\n([\s\S]*?)^```\s*$/gm)];
  if (matches.length !== 1) throw new SynapseError('Expected exactly one fenced diff block');
  const patch = matches[0][1];
  if (!patch.startsWith('diff --git ') || Buffer.byteLength(patch) > 55_000 || patch.includes('\0')) throw new SynapseError('Invalid or oversized diff');
  if (/^(?:GIT binary patch|Binary files |rename (?:from|to) |copy (?:from|to) |(?:old|new) mode |(?:new file|deleted file) mode (?!100644$))/m.test(patch))
    throw new SynapseError('Only ordinary text edits, additions and deletions are supported');
  return patch.endsWith('\n') ? patch : patch + '\n';
}
export function reviewedContribution(run: RunRecord, taskId: string) {
  const task = run.tasks.find(t => t.id === taskId);
  if (run.status !== 'completed' || !task || task.status !== 'completed' || !task.review || !task.reviewResult || !task.patch || !task.result)
    throw new SynapseError('A completed run and independently reviewed patch task are required');
  validatePatchContract(task.patch);
  const patch = extractPatch(task.result);
  return { patch, contract: task.patch, sha256: createHash('sha256').update(patch).digest('hex') };
}
function git(cwd: string, args: string[], input?: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const result = spawnSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args], {cwd, env, input, encoding:'utf8', timeout:30_000, maxBuffer: 2*1024*1024});
  if (result.error || result.status !== 0) throw new SynapseError(`Git ${args[0]} failed: ${String(result.error ?? result.stderr).slice(0,1500)}`);
  return result.stdout;
}
export async function stageContribution(project: string, run: RunRecord, taskId: string, expectedHash: string) {
  const { patch, contract, sha256 } = reviewedContribution(run, taskId);
  if (expectedHash !== sha256) throw new SynapseError('Patch digest mismatch: inspect the contribution again');
  const root = await realpath(git(project,['rev-parse','--show-toplevel']).trim());
  if (root !== await realpath(project)) throw new SynapseError('Pass the repository root explicitly');
  if (git(root,['rev-parse','HEAD']).trim() !== contract.baseCommit) throw new SynapseError('Repository HEAD differs from the reviewed base');
  const stats = git(root,['apply','--numstat','-z','-'],patch).split('\0').filter(Boolean);
  const paths = stats.map(s => {
    const m = /^(\d+)\t(\d+)\t(.+)$/.exec(s);
    if (!m) throw new SynapseError('Unsupported patch file entry');
    return m[3];
  });
  if (!paths.length || new Set(paths).size !== paths.length || paths.some(p => !contract.paths.includes(p))) throw new SynapseError('Patch exceeds declared file scope');
  // Refuse existing symlinks/submodules or nonregular files on the reviewed base.
  for (const path of paths) {
    const entry = git(root,['ls-tree',contract.baseCommit,'--',path]).trim();
    if (entry && !/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) throw new SynapseError('Nonregular tracked target');
  }
  const worktree = await mkdtemp(join(tmpdir(),'synapse-contribution-'));
  try {
    git(root,['worktree','add','--detach',worktree,contract.baseCommit]);
    git(worktree,['apply','--check','--index','-'],patch);
    git(worktree,['apply','--index','-'],patch);
    const changed = git(worktree,['diff','--cached','--name-only','-z']).split('\0').filter(Boolean);
    if (changed.length !== paths.length || changed.some(p => !paths.includes(p))) throw new SynapseError('Unexpected changed files');
    return {worktree, baseCommit:contract.baseCommit, sha256, paths:changed, status:'staged_for_manual_review', testsExecuted:false};
  } catch (error) {
    try { git(root,['worktree','remove','--force',worktree]); } catch { await rmdir(worktree).catch(()=>undefined); }
    throw error;
  }
}
