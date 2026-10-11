import test from 'node:test';
import assert from 'node:assert/strict';
import {runAccount} from './account.mjs';
test('Account CLI fails closed on writes, unsupported routes and Gateway Keys',async()=>{
 let called=false;const opts={env:{YIR_ACCOUNT_API_KEY:'yir_ak_test'},fetch:async()=>{called=true;return Response.json({code:200,data:[]})}};
 await assert.rejects(runAccount(['routing','archive','--id','123'],opts),/write_flag/);
 await assert.rejects(runAccount(['admin','list'],opts),/unsupported/);
 await assert.rejects(runAccount(['routing','list'],{...opts,env:{YIR_ACCOUNT_API_KEY:'yir_sk_test'}}),/required/);
 assert.equal(called,false);
});
test('Account CLI uses separate API host and does not follow redirects',async()=>{
 const result=await runAccount(['analytics','get','--query','{"group_by":"model","core_model":["modelA","modelB"]}'],{env:{YIR_ACCOUNT_API_KEY:'yir_ak_test'},fetch:async(url,init)=>{
  assert.equal(url.searchParams.get('core_model'),'modelA,modelB');
  assert.equal(url.origin,'https://api.yir.ai');assert.equal(url.pathname,'/account/v1/analytics');assert.equal(init.redirect,'manual');return Response.json({code:200,data:{total:7}});
 }});assert.deepEqual(result,{total:7});
});
