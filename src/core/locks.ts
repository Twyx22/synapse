/** Cooperative local-filesystem locks. Fail closed on abandoned locks: never steal. */
import { mkdir, rmdir, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { SynapseError } from './types.ts';
const valid=/^(run_[a-f0-9-]{36}\.(update|execute)|idea_[a-f0-9-]{36}\.(update|deliberate)|evolution-config\.update)$/;
export async function acquireLock(directory:string,key:string,waitMs=0):Promise<()=>Promise<void>> {
  if(!valid.test(key))throw new SynapseError('Invalid lock key');
  const root=join(directory,'.locks'); await mkdir(root,{recursive:true,mode:0o700});
  const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new SynapseError('Lock directory must be private, owned and not a symlink');
  const path=join(root,key),deadline=performance.now()+waitMs;
  for(;;){
    try{await mkdir(path,{mode:0o700});break;}
    catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      if(performance.now()>=deadline)throw new SynapseError(`Lock busy or abandoned: ${key}. Inspect offline; never remove a live lock.`);
      await sleep(Math.min(25,Math.max(1,deadline-performance.now())));}
  }
  let released=false;
  return async()=>{if(released)return;await rmdir(path);released=true;};
}
export async function inspectLocks(directory:string){
  const read=async(dir:string)=>{try{return (await readdir(join(dir,'.locks'),{withFileTypes:true})).map(e=>({key:e.name,recognized:valid.test(e.name)&&e.isDirectory()})).sort((a,b)=>a.key.localeCompare(b.key));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
  const [runs,evolution]=await Promise.all([read(directory),read(join(directory,'evolution'))]);
  return {runs,evolution,policy:'cooperative local filesystem; active or abandoned, not automatically distinguished; never steal'};
}
