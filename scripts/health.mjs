#!/usr/bin/env node
/** Read-only runtime check. No model calls, config mutations or service restarts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
export function inspectHealth(payload, project, plugin) {
  if (payload?.location?.directory !== project || !Array.isArray(payload.data)) return {status:'wrong_or_invalid_location'};
  const matches = payload.data.filter(p => p?.id === 'synapse');
  if (matches.length !== 1) return {status:matches.length ? 'duplicate' : 'not_ready', count:matches.length};
  const p = matches[0];
  if (p.source?.type !== 'local' || p.source.path !== plugin) return {status:'wrong_source', count:1};
  if (p.state?.status !== 'active' || p.features?.server !== true) return {status:'not_active', count:1};
  return {status:'active', count:1, source:plugin, project, versionVerified:false};
}
export async function waitHealth({project, plugin, attempts=12, delayMs=1000, query=async path => {
  const endpoint = '/api/plugin?location%5Bdirectory%5D='+encodeURIComponent(path);
  const {stdout} = await exec('opencode',['api','GET',endpoint],{cwd:path, timeout:5000, maxBuffer:2*1024*1024});
  return JSON.parse(stdout);
}}) {
  if (!Number.isInteger(attempts)||attempts<1||attempts>30) throw Error('Invalid attempt count');
  let result={status:'unavailable'};
  for (let i=1;i<=attempts;i++) {
    try { result=inspectHealth(await query(project),project,plugin); } catch { result={status:'unavailable'}; }
    if (result.status==='active'||result.status==='duplicate'||result.status==='wrong_source') return {...result,attempts:i};
    if(i<attempts) await new Promise(r=>setTimeout(r,delayMs));
  }
  return {...result,attempts};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    let project=process.cwd(), plugin=root;
    const args=process.argv.slice(2);
    for(let i=0;i<args.length;i+=2) {
      if(!args[i+1]) throw Error('Missing argument');
      if(args[i]==='--project') project=resolve(args[i+1]);
      else if(args[i]==='--plugin') plugin=resolve(args[i+1]);
      else throw Error('Use --project PATH [--plugin PATH]');
    }
    const result=await waitHealth({project,plugin});
    console.log(JSON.stringify(result,null,2));
    if(result.status!=='active') process.exitCode=1;
  } catch(e) {console.error('Synapse health: '+e.message);process.exitCode=1;}
}
