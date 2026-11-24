#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, unlink, lstat } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute }  from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
const root = dirname(dirname(fileURLToPath(import.meta.url)));

// JSONC comments and trailing commas are removed only outside string tokens.
export function parseConfig(source) {
  const withoutComments = source.replace(/^\uFEFF/, '').replace(/"(?:\\[\s\S]|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ');
  const clean = withoutComments.replace(/"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : '');
  const value = JSON.parse(clean);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an OpenCode configuration object');
  return value;
}
async function exists(path) {
  try { const st = await lstat(path); if (!st.isFile()) throw new Error(`Not a regular file: ${path}`); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function atomicWrite(path, text, previous) {
  await mkdir(dirname(path), { recursive: true });
  const backup = previous === undefined ? null : `${path}.synapse-backup-${randomUUID()}`;
  if (backup) await writeFile(backup, previous, { flag: 'wx', mode: 0o600 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, text, { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
  return backup;
}
export async function install({ directory, global = false, dryRun = false, plugin = root }) {
  const base = resolve(directory);
  const nested = global ? base : join(base, '.opencode');
  const candidates = [...new Set([join(base, 'opencode.json'), join(base, 'opencode.jsonc'), join(nested, 'opencode.json'), join(nested, 'opencode.jsonc')])];
  const present = [];
  for (const path of candidates) if (await exists(path)) present.push(path);
  if (present.length > 1) throw new Error('Multiple OpenCode configs found; merge manually to avoid overriding existing settings.');
  const configPath = present[0] ?? join(base, 'opencode.jsonc');
  const original = present.length ? await readFile(configPath, 'utf8') : undefined;
  const config = original === undefined ? { $schema: 'https://opencode.ai/config.json' } : parseConfig(original);
  if ('plugin' in config || 'agent' in config) throw new Error('Legacy V1 config detected; migrate to OpenCode V2 first.');
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('plugins must be an array');
  const pluginPath = resolve(plugin);
  const entries = config.plugins ?? [];
  const kept = [], removed = [], current = [];
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.package;
    const local = typeof name === 'string' && (isAbsolute(name) || name.startsWith('./') || name.startsWith('../'));
    const path = local ? resolve(dirname(configPath), name) : null;
    if (path === pluginPath) { current.push(entry); continue; }
    let oldSynapse = false;
    if (path) {
      try { oldSynapse = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).name === 'synapse-opencode'; }
      catch { /* Unknown or missing package: never silently remove it. */ }
    }
    if (oldSynapse) {
      if (typeof entry !== 'string') throw new Error('Stale Synapse entry has custom options; review it manually: '+path);
      removed.push(name);
    } else kept.push(entry);
  }
  const configured = current.filter(entry => typeof entry !== 'string');
  if (configured.length > 1) throw new Error('Multiple configured Synapse entries; merge manually');
  const selected = configured[0] ?? pluginPath;
  // Preserve the position of the first existing current entry where possible.
  const first = entries.findIndex(entry => current.includes(entry));
  if (first >= 0) {
    const preceding = entries.slice(0, first).filter(entry => kept.includes(entry)).length;
    kept.splice(preceding, 0, selected);
  } else kept.push(selected);
  config.plugins = kept;
  config.default_agent = 'synapse';
  if (config.agents?.synapse) throw new Error('Existing inline agent synapse; merge manually rather than override.');
  const agentPath = join(nested, 'agents', 'synapse.md');
  const profile = await readFile(join(root, 'agents', 'synapse.md'), 'utf8');
  const oldProfile = await exists(agentPath) ? await readFile(agentPath, 'utf8') : undefined;
  const nextConfig = JSON.stringify(config, null, 2) + '\n';
  const result = { configPath, agentPath, pluginPath, previousDefault: original ? parseConfig(original).default_agent ?? null : null, dryRun, removedStaleSynapse: removed, duplicateCurrentEntries: Math.max(0,current.length-1), backups: [] };
  if (!dryRun) {
    if (profile !== oldProfile) { const backup = await atomicWrite(agentPath, profile, oldProfile); if (backup) result.backups.push(backup); }
    if (nextConfig !== original) { const backup = await atomicWrite(configPath, nextConfig, original); if (backup) result.backups.push(backup); }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    let directory, global = false, dryRun = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--project' && args[i+1]) directory = args[++i];
      else if (args[i] === '--global') global = true;
      else if (args[i] === '--dry-run') dryRun = true;
      else throw new Error('Usage: npm run setup -- --project /path/to/project [--dry-run] OR --global [--dry-run]');
    }
    if (global === !!directory) throw new Error('Choose exactly one of --project PATH or --global');
    if (global) directory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
    console.log(JSON.stringify(await install({ directory, global, dryRun }), null, 2));
    console.log('Existing JSONC comments are retained in the backup, not in the rewritten config. Restart OpenCode and create a new session.');
  } catch (err) { console.error(`Synapse setup: ${err.message}`); process.exitCode = 1; }
}
