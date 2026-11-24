import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error JavaScript CLI module
import { inspectHealth, waitHealth } from '../scripts/health.mjs';
const project='/project',plugin='/install';
const active={id:'synapse',source:{type:'local',path:plugin},features:{server:true},state:{status:'active'}};
const payload=(data:unknown[],directory=project)=>({location:{directory},data});
test('health requires exact project and source, a single active server plugin',()=>{
  assert.equal(inspectHealth(payload([active]),project,plugin).status,'active');
  assert.equal(inspectHealth(payload([active],'/wrong'),project,plugin).status,'wrong_or_invalid_location');
  assert.equal(inspectHealth(payload([active,active]),project,plugin).status,'duplicate');
  assert.equal(inspectHealth(payload([{...active,source:{type:'local',path:'/old'}}]),project,plugin).status,'wrong_source');
  assert.equal(inspectHealth(payload([{...active,state:{status:'failed'}}]),project,plugin).status,'not_active');
  assert.equal(inspectHealth(payload([active]),project,plugin).versionVerified,false);
});
test('health waits for readiness and stops boundedly on failures',async()=>{
  let count=0;const outcome=await waitHealth({project,plugin,attempts:4,delayMs:0,query:async(p:string)=>{assert.equal(p,project);count++;if(count===1)throw Error('restart');return payload(count===2?[]:[active]);}});
  assert.equal(outcome.status,'active');assert.equal(outcome.attempts,3);
  assert.equal((await waitHealth({project,plugin,attempts:2,delayMs:0,query:async()=>payload([])})).status,'not_ready');
  assert.equal((await waitHealth({project,plugin,attempts:2,delayMs:0,query:async()=>payload([active,active])})).attempts,1);
});
