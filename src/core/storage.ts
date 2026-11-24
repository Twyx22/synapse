import { inspectLocks } from "./locks.ts";
/** Project-local identity with durable XDG data; migration is copy-only and offline. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, realpath, readdir, open, link, unlink, rmdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const maxBytes = 64 * 1024 * 1024;
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
async function stat(path: string) { try { return await lstat(path); } catch (e) { if (missing(e)) return undefined; throw e; } }
async function privateDir(path: string) {
  await mkdir(path, {recursive:true, mode:0o700});
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid())) throw new Error(`Storage directory must be private, owned and not a symlink: ${path}`);
}
async function safeRead(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s=await f.stat(); if (!s.isFile() || s.size>maxBytes) throw new Error('Not a regular bounded file'); const b=await f.readFile(); if(b.length>maxBytes) throw new Error('File exceeds limit'); return b; } finally { await f.close(); }
}
/** Atomic publication, never overwriting a destination even if another writer races. */
async function publish(path: string, bytes: Buffer | string) {
  const tmp=`${path}.${randomUUID()}.tmp`;
  const f=await open(tmp,'wx',0o600);
  try { try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); } await link(tmp,path); }
  finally { await unlink(tmp).catch(()=>undefined); }
}
const defaultDataHome = () => process.env.XDG_DATA_HOME || join(homedir(),'.local','share');
export async function projectStorage(project: string, dataHome = defaultDataHome()) {
  const root=await realpath(resolve(project));
  if (!(await lstat(root)).isDirectory()) throw new Error('Project must be a directory');
  if (!isAbsolute(dataHome)) throw new Error('XDG_DATA_HOME must be absolute');
  const base=join(dataHome,'synapse'), id=digest(root), projects=join(base,'projects'), directory=join(projects,id);
  return {project:root, id, base, projects, directory, legacy:join(root,'.opencode','synapse-data')};
}
type Location = Awaited<ReturnType<typeof projectStorage>>;
const patterns: Record<string,RegExp> = {'':/^run_[a-f0-9-]{36}\.json$/, evolution:/^(idea_[a-f0-9-]{36}\.json|config\.json)$/, experiments:/^experiment_[a-f0-9-]{36}\.json$/, diagnostics:/^synapse\.jsonl(?:\.\d+)?$/};
async function inventory(source: string) {
  const entries: {group:string; name:string; path:string}[]=[];
  const root=await stat(source);
  if (!root) return entries;
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Migration source must be a real directory');
  for (const [group, pattern] of Object.entries(patterns)) {
    const dir=join(source,group), s=await stat(dir);
    if (!s) continue;
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error(`Invalid source directory: ${group}`);
    for (const name of (await readdir(dir)).sort()) if(pattern.test(name)) entries.push({group,name,path:join(dir,name)});
  }
  return entries;
}
function validRecord(group:string,name:string,bytes:Buffer) {
  if(group==='diagnostics'||name==='config.json') return false; // archival only; do not reactivate old model-call settings
  const o=JSON.parse(bytes.toString('utf8'));
  if(o?.schema!==1 || o.id!==name.slice(0,-5)) return false;
  if(group==='') return typeof o.objective==='string' && typeof o.updatedAt==='string' && Array.isArray(o.tasks)&&Array.isArray(o.events)&&Array.isArray(o.messages)&&!!o.options;
  if(group==='evolution') return typeof o.kind==='string'&&typeof o.updatedAt==='string'&&Array.isArray(o.opinions)&&Array.isArray(o.evidence)&&Array.isArray(o.revisionHistory);
  return Array.isArray(o.pairs)&&Array.isArray(o.expected)&&typeof o.createdAt==='string';
}
async function prepare(loc:Location) {
  for (const p of [loc.base,loc.projects,loc.directory,...['evolution','experiments','diagnostics','reports'].map(d=>join(loc.directory,d))]) await privateDir(p);
  const meta=join(loc.directory,'project.json');
  try { await publish(meta,JSON.stringify({schema:1,project:loc.project,id:loc.id},null,2)); }
  catch(e) { if((e as NodeJS.ErrnoException).code!=='EEXIST') throw e; const m=JSON.parse((await safeRead(meta)).toString()); if(m.schema!==1||m.id!==loc.id||m.project!==loc.project) throw new Error('Project identity mismatch'); }
}
export async function storageDoctor(loc:Location) {
  const inspect=async(dir:string)=>{
    const counts={runs:0,ideas:0,experiments:0,invalid:0,archival:0};
    for(const f of await inventory(dir)) {
      if(f.group==='diagnostics'||f.name==='config.json'){counts.archival++;continue;}
      try {if(!validRecord(f.group,f.name,await safeRead(f.path))) throw new Error('invalid'); if(!f.group)counts.runs++;else if(f.group==='evolution')counts.ideas++;else counts.experiments++;} catch {counts.invalid++;}
    }
    return counts;
  };
  const persistent=await inspect(loc.directory),legacy=await inspect(loc.legacy);
  const initialized=!!(await stat(join(loc.directory,'project.json')));
  if(initialized) await verifyIdentity(loc);
  return {project:loc.project,projectId:loc.id,directory:loc.directory,legacyDirectory:loc.legacy,persistent,legacy,initialized,locks:await inspectLocks(loc.directory),migrationRecorded:!!(await stat(join(loc.directory,'legacy-import.json'))),migrationLockPresent:!!(await stat(join(loc.directory,'.migration-lock')))};
}
export async function migrateStorage(loc:Location, source=loc.legacy, automatic=false) {
  await prepare(loc);
  const marker=join(loc.directory,'legacy-import.json');
  if(automatic && await stat(join(loc.directory,'.migration-lock'))) throw new Error('Storage migration is locked; inspect offline before starting OpenCode');
  if(automatic && await stat(marker)) return {status:'already_migrated' as const, imported:0, identical:0, conflicts:0, invalid:0, archived:0};
  const sourcePath=resolve(source);
  if(sourcePath===loc.directory) throw new Error('Source and destination must differ');
  if(!(await stat(sourcePath))) return {status:'no_source' as const, imported:0, identical:0, conflicts:0, invalid:0, archived:0};
  if(await realpath(sourcePath)===await realpath(loc.directory)) throw new Error('Source and destination must differ');
  const lock=join(loc.directory,'.migration-lock');
  await mkdir(lock,{mode:0o700}); // fail closed if another migration or an interrupted migration exists
  try {
    if(automatic && await stat(marker)) return {status:'already_migrated' as const, imported:0, identical:0, conflicts:0, invalid:0, archived:0};
    const files=await inventory(sourcePath);
    const backups=join(loc.base,'backups'), projectBackups=join(backups,loc.id), backup=join(projectBackups,randomUUID());
    for(const p of [backups,projectBackups,backup]) await privateDir(p);
    const results:{name:string;status:string;sha256?:string}[]=[];
    let imported=0,identical=0,conflicts=0,invalid=0,archived=0;
    for(const f of files) {
      const name=join(f.group,f.name); let bytes:Buffer;
      try {bytes=await safeRead(f.path);} catch {invalid++;results.push({name,status:'unreadable'});continue;}
      const sha256=digest(bytes);
      await privateDir(join(backup,f.group));
      await publish(join(backup,name),bytes); // preserve every readable recognized record before import
      if(f.group==='diagnostics'||f.name==='config.json'){archived++;results.push({name,status:'archived',sha256});continue;}
      try {if(!validRecord(f.group,f.name,bytes))throw new Error('invalid');} catch {invalid++;results.push({name,status:'invalid',sha256});continue;}
      await privateDir(join(loc.directory,f.group));
      const target=join(loc.directory,name);
      try {await publish(target,bytes);imported++;results.push({name,status:'imported',sha256});}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const equal=await safeRead(target).then(b=>b.equals(bytes)).catch(()=>false);if(equal)identical++;else conflicts++;results.push({name,status:equal?'identical':'conflict',sha256});}
    }
    const summary={status:'finished' as const,imported,identical,conflicts,invalid,archived,backup};
    await publish(join(backup,'migration.json'),JSON.stringify({schema:1,source:sourcePath,project:loc.project,at:new Date().toISOString(),...summary,results},null,2));
    if(sourcePath===loc.legacy && !(await stat(marker))) await publish(marker,JSON.stringify({schema:1,...summary},null,2));
    return summary;
  } finally {await rmdir(lock);}
}
export async function initializeStorage(project:string) { const loc=await projectStorage(project); const migration=await migrateStorage(loc,loc.legacy,true); return {...loc,migration}; }
/** Offline consumers share exact identity with the plugin; old un-migrated projects remain readable. */
export async function resolveDataDirectory(project:string, create=false) {
  const loc=await projectStorage(project);
  if(await stat(join(loc.directory,'project.json'))) { await verifyIdentity(loc); return loc.directory; }
  if(await stat(loc.legacy)) return loc.legacy;
  if(create) await prepare(loc);
  return loc.directory;
}

async function verifyIdentity(loc: Location) {
  const dir=await lstat(loc.directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()) throw new Error('Invalid project storage directory');
  const m=JSON.parse((await safeRead(join(loc.directory,'project.json'))).toString());
  if(m.schema!==1||m.id!==loc.id||m.project!==loc.project) throw new Error('Project identity mismatch');
}
/** Local-only discovery; does not open foreign run contents or activate another project. */
export async function discoverProjects(dataHome=defaultDataHome()) {
  if(!isAbsolute(dataHome)) throw new Error('XDG_DATA_HOME must be absolute');
  const projects=join(dataHome,'synapse','projects');
  const root=await stat(projects);
  if(!root) return {projects:[],invalid:0,truncated:false};
  if(!root.isDirectory()||root.isSymbolicLink()) throw new Error('Invalid projects directory');
  const names=(await readdir(projects)).filter(n=>/^[a-f0-9]{64}$/.test(n)).sort();
  const found:{projectId:string;project:string;pathAvailable:boolean;runFiles:number;ideaFiles:number;experimentFiles:number}[]=[];
  let invalid=0;
  for(const id of names.slice(0,500)) {
    try {
      const directory=join(projects,id), dir=await lstat(directory);
      if(!dir.isDirectory()||dir.isSymbolicLink()) throw new Error('Invalid directory');
      const m=JSON.parse((await safeRead(join(directory,'project.json'))).toString());
      if(m.schema!==1||m.id!==id||typeof m.project!=='string'||!isAbsolute(m.project)||digest(m.project)!==id) throw new Error('Invalid identity');
      const entries=await inventory(directory);
      const pathAvailable=await realpath(m.project).then(p=>p===m.project).catch(()=>false);
      found.push({projectId:id,project:m.project,pathAvailable,runFiles:entries.filter(e=>!e.group).length,ideaFiles:entries.filter(e=>e.group==='evolution'&&e.name!=='config.json').length,experimentFiles:entries.filter(e=>e.group==='experiments').length});
    } catch {invalid++;}
  }
  return {projects:found,invalid,truncated:names.length>500};
}
/** Export only current project fingerprint and counts, never filesystem paths. */
export async function storageReport(loc:Location, selectedDirectory:string) {
  const d=await storageDoctor(loc);
  const source=selectedDirectory===loc.directory?'persistent':selectedDirectory===loc.legacy?'legacy':'unknown';
  return {projectId:d.projectId,source,persistent:d.persistent,legacy:d.legacy,initialized:d.initialized,migrationRecorded:d.migrationRecorded,migrationLockPresent:d.migrationLockPresent,lockCounts:{runs:d.locks.runs.length,evolution:d.locks.evolution.length},
    warning: source==='unknown'?'directory_mismatch':d[source].runs===0?'empty_project_history':undefined};
}
