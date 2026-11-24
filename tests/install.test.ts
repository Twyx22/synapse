import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error Dependency-free JavaScript installer.
import { install, parseConfig } from '../scripts/install.mjs';

test('JSONC parser preserves strings containing URLs, comments and commas', () => {
  assert.deepEqual(parseConfig('{ // comment\n"url":"https://example.org/a/*b*/", "list":["x,}",], }'), { url: 'https://example.org/a/*b*/', list: ['x,}'] });
});
test('installer preserves settings, sets default agent, backs up and is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-install-'));
  try {
    const path = join(dir, 'opencode.jsonc');
    const initial = '{ // my settings\n"model":"example/model", "plugins":["another"], "default_agent":"build", }';
    await writeFile(path, initial);
    await install({ directory: dir, dryRun: true });
    assert.equal(await readFile(path, 'utf8'), initial);
    const result = await install({ directory: dir });
    const config = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(config.model, 'example/model');
    assert.equal(config.default_agent, 'synapse');
    assert.equal(config.plugins[0], 'another');
    assert.equal(config.plugins.length, 2);
    assert.equal(await readFile(result.backups[0], 'utf8'), initial);
    assert.match(await readFile(result.agentPath, 'utf8'), /mode: primary/);
    assert.deepEqual((await install({ directory: dir })).backups, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('installer refuses conflicting configuration files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synapse-install-'));
  try {
    await writeFile(join(dir, 'opencode.json'), '{}'); await writeFile(join(dir, 'opencode.jsonc'), '{}');
    await assert.rejects(install({ directory: dir }), /Multiple OpenCode configs/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('installer removes only verified stale Synapse paths and collapses current duplicates', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-dedup-'));
  try {
    const {mkdir}=await import('node:fs/promises');
    const old=join(dir,'old'),current=join(dir,'current'),unknown=join(dir,'unknown');
    await mkdir(old);await writeFile(join(old,'package.json'),JSON.stringify({name:'synapse-opencode'}));
    const path=join(dir,'opencode.jsonc'); const original=JSON.stringify({plugins:['another',old,current,current,unknown]});await writeFile(path,original);
    const dry=await install({directory:dir,plugin:current,dryRun:true});assert.deepEqual(dry.removedStaleSynapse,[old]);assert.equal(await readFile(path,'utf8'),original);
    const result=await install({directory:dir,plugin:current});assert.equal(result.duplicateCurrentEntries,1);assert.deepEqual(JSON.parse(await readFile(path,'utf8')).plugins,['another',current,unknown]);assert.equal(await readFile(result.backups[0],'utf8'),original);
    assert.equal(JSON.parse(await readFile(join(old,'package.json'),'utf8')).name,'synapse-opencode');
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('installer refuses stale entries with custom options instead of silently losing settings',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'synapse-options-'));
  try {const {mkdir}=await import('node:fs/promises');const old=join(dir,'old');await mkdir(old);await writeFile(join(old,'package.json'),'{"name":"synapse-opencode"}');const path=join(dir,'opencode.jsonc'),original=JSON.stringify({plugins:[{package:old,enabled:false}]});await writeFile(path,original);await assert.rejects(install({directory:dir,plugin:join(dir,'current')}),/custom options/);assert.equal(await readFile(path,'utf8'),original);}
  finally{await rm(dir,{recursive:true,force:true});}
});
