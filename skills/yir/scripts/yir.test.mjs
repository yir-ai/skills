import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const script = fileURLToPath(new URL('./yir.mjs', import.meta.url));
async function fixture(t, jobs, state = {jobs:{}}) {
  const dir = await mkdtemp(join(tmpdir(), 'yir-test-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const plan = join(dir,'plan.json');
  await writeFile(plan, JSON.stringify({defaults:{type:'image',model:'test/image',prompt:'test',max_cost:'0.05'},jobs:jobs.map(name=>({name}))}));
  await writeFile(join(dir,'.yir-batch.json'),JSON.stringify(state));
  const mock = join(dir,'mock.mjs');
  await writeFile(mock, `
  import {appendFile} from 'node:fs/promises';
  globalThis.fetch = async (url, opts={}) => {
    const p = new URL(url).pathname;
    let data;
    if(p.includes('/models/')) data={operations:[{operation:'generate_image',input_modes:['text'],parameters:[{name:'size',type:'string',required:false,values:['3136x1344']}]}]};
    else if(p.endsWith('/quotes')) { if ('max_cost' in JSON.parse(opts.body)) return new Response(JSON.stringify({error:{code:'YIR_INVALID_REQUEST',message:'max_cost is not allowed in this request.'}}),{status:400}); data=process.env.UNKNOWN_QUOTE==='1'?{primary:{amount:null},supply:{available:true}}:{expected_amount:'0.05',supply:{available:true}}; }
    else if(p.endsWith('/generations')) {
      await appendFile(process.env.CALLS,JSON.stringify(JSON.parse(opts.body))+'\\n');
      data={id:'2',status:'queued'};
    } else if(p.endsWith('/status')) {
      if(process.env.RATE_LIMIT_STATUS==='1' && !globalThis.limited) { globalThis.limited=true; return new Response(JSON.stringify({error:{code:'YIR_RATE_LIMITED',retryable:true}}),{status:429,headers:{'retry-after':'1'}}); }
      if(process.env.FAIL_STATUS==='1') return new Response(JSON.stringify({error:{code:'YIR_UNAUTHORIZED',retryable:false}}),{status:401});
      data={status:'succeeded'};
    }
    else if(p.startsWith('/v1/jobs/')) data={id:p.split('/').at(-1),status:'succeeded',billing:{status:process.env.PENDING_BILL==='1'?'pending':'settled',total_charged_by_yir:p.endsWith('/1')?'0.08':'0.05'},result:{availability:'available',files:[{url:'https://mock/asset',media_type:'image/png'}]}};
    else if(p==='/asset') return new Response('image',{status:process.env.FAIL_DOWNLOAD==='1'?503:200});
    else throw Error('unexpected '+p);
    return new Response(JSON.stringify(data));
  };`);
  return {dir, async run(extra=[], env={}, maxTotal="0.10") {
    let result;
    try { result=await exec(process.execPath,['--import',pathToFileURL(mock).href,script,'batch',plan,'--out',dir,...(maxTotal===null?[]:['--max-total',maxTotal]),...extra],{env:{...process.env,YIR_API_KEY:'mock',YIR_BASE_URL:'https://mock',CALLS:join(dir,'calls'),...env}});result.code=0; }
    catch(e){result=e;}
    const calls=await readFile(join(dir,'calls'),'utf8').catch(()=> '');
    return {...result, state:JSON.parse(await readFile(join(dir,'.yir-batch.json'),'utf8')), calls:calls.trim()?calls.trim().split('\n').map(JSON.parse):[]};
  }};
}
test('resumed in-flight bill prevents new spend beyond total',async t=>{
 const f=await fixture(t,['old','new'],{jobs:{old:{job_id:'1',status:'running',quote:.08}}});
 const r=await f.run();assert.equal(r.calls.length,0);assert.equal(r.state.jobs.new.status,'skipped_budget');
});
test('pending terminal billing keeps the reserved cap across runs',async t=>{
 const f=await fixture(t,['a','b']);
 const first=await f.run(['--concurrency','1'],{PENDING_BILL:'1'},'0.10');
 assert.equal(first.calls.length,2);assert.equal(first.state.jobs.a.billing_status,'pending');
 const path=join(f.dir,'plan.json');const plan=JSON.parse(await readFile(path,'utf8'));
 plan.jobs.push({name:'c'});await writeFile(path,JSON.stringify(plan));
 const pending=await f.run([],{PENDING_BILL:'1'},'0.10');
 assert.equal(pending.calls.length,2);assert.equal(pending.state.jobs.c.status,'skipped_budget');
 const settled=await f.run([],{},'0.15');
 assert.equal(settled.calls.length,3);assert.equal(settled.state.jobs.a.billing_status,'settled');
});
test('concurrent admissions reserve caps before awaits',async t=>{
 const f=await fixture(t,['a','b'],{jobs:{prior:{status:'failed',charged_usd:'0.05'}}});
 const r=await f.run();assert.equal(r.calls.length,1);assert.equal(r.calls[0].max_cost,'0.050000');
});
test('download failure exits nonzero and resumes without resubmission or double charge',async t=>{
 const f=await fixture(t,['asset']);const first=await f.run([],{FAIL_DOWNLOAD:'1'});
 assert.equal(first.code,1);assert.equal(first.state.jobs.asset.download_status,'failed');
 const second=await f.run();assert.equal(second.code,0);assert.equal(second.calls.length,1);
 assert.equal(second.state.jobs.asset.download_status,'succeeded');
 assert.equal(JSON.parse(second.stdout).charged_total_usd,'0.0500');
});
test('retry retains previously charged failures',async t=>{
 const f=await fixture(t,['asset'],{jobs:{asset:{job_id:'1',status:'failed',charged_usd:'0.08'}}});
 const r=await f.run(['--retry-failed']);assert.equal(r.calls.length,0);assert.equal(r.state.prior_charged_usd,.08);
});
test('unresolved job omitted from plan blocks fresh spend',async t=>{
 const f=await fixture(t,['new'],{jobs:{old:{job_id:'1',status:'running',quote:.08}}});
 const r=await f.run();assert.equal(r.calls.length,0);
});
test('corrupt state fails closed',async t=>{
 const f=await fixture(t,['new']);await writeFile(join(f.dir,'.yir-batch.json'),'{');
 await assert.rejects(()=>exec(process.execPath,[script,'batch',join(f.dir,'plan.json'),'--out',f.dir],{env:{...process.env,YIR_API_KEY:'mock'}}),e=>e.code===2 && e.stderr.includes('cannot read batch state'));
});

test('status failure retains reservation instead of admitting more spending',async t=>{
 const f=await fixture(t,['a','b'],{jobs:{prior:{status:'failed',charged_usd:'0.05'}}});
 const r=await f.run(['--concurrency','1'],{FAIL_STATUS:'1'});
 assert.equal(r.calls.length,1);assert.equal(r.state.jobs.b.status,'skipped_budget');
});
test('unresolved resumed job blocks new submissions on status failure',async t=>{
 const f=await fixture(t,['old','new'],{jobs:{old:{job_id:'1',status:'running',quote:.08}}});
 const r=await f.run([],{FAIL_STATUS:'1'});assert.equal(r.calls.length,0);assert.equal(r.state.jobs.new.status,'skipped_budget');
});

test('uncapped uncertain submit cannot be replayed under a finite total',async t=>{
 const f=await fixture(t,['old'],{prior_charged_usd:.08,jobs:{old:{idempotency_key:'original',status:'submit_error',quote:.05,body:{model:'test/image',input:{prompt:'test'},parameters:{}}}}});
 const r=await f.run();assert.equal(r.calls.length,0);assert.equal(r.code,1);assert.equal(r.state.jobs.old.idempotency_key,'original');
});
test('capped uncertain replay includes prior spend and keeps original request',async t=>{
 const state={prior_charged_usd:.08,jobs:{old:{idempotency_key:'original',status:'submit_error',quote:.05,body:{model:'test/image',input:{prompt:'test'},parameters:{},max_cost:'0.05'}}}};
 const f=await fixture(t,['old'],state);const r=await f.run();assert.equal(r.calls.length,0);
 const resumed=await f.run(['--max-total','0.20']);assert.equal(resumed.calls.length,1);assert.equal(resumed.calls[0].max_cost,'0.05');
});
test('uncertain submit with missing quote fails closed',async t=>{
 const f=await fixture(t,['old'],{jobs:{old:{idempotency_key:'original',body:{model:'test/image',input:{prompt:'test'},parameters:{}}}}});
 const r=await f.run();assert.equal(r.calls.length,0);assert.equal(r.code,2);assert.match(r.stderr,/no valid quote/);
});

test('omitted job cap uses the quote as the generation cap',async t=>{
 const f=await fixture(t,['asset']);const path=join(f.dir,'plan.json');const plan=JSON.parse(await readFile(path,'utf8'));
 delete plan.defaults.max_cost;await writeFile(path,JSON.stringify(plan));
 const r=await f.run();assert.equal(r.code,0);assert.equal(r.calls[0].max_cost,'0.050000');
});
test('explicit job cap survives quoting without a batch total',async t=>{
 const f=await fixture(t,['asset']);const r=await f.run([],{},null);
 assert.equal(r.code,0);assert.equal(r.calls[0].max_cost,'0.05');
});

test('unknown price can submit without a budget and is never reported as zero',async t=>{
 const f=await fixture(t,['asset']);const path=join(f.dir,'plan.json');const plan=JSON.parse(await readFile(path,'utf8'));
 delete plan.defaults.max_cost;await writeFile(path,JSON.stringify(plan));
 const r=await f.run([],{UNKNOWN_QUOTE:'1'},null);
 assert.equal(r.code,0);assert.equal(r.calls.length,1);assert.equal(r.calls[0].max_cost,undefined);
 assert.equal(JSON.parse(r.stdout).quoted_total_usd,null);
});

test('unknown price needs an explicit allocation under a total budget',async t=>{
 const f=await fixture(t,['asset']);const path=join(f.dir,'plan.json');const plan=JSON.parse(await readFile(path,'utf8'));
 delete plan.defaults.max_cost;await writeFile(path,JSON.stringify(plan));
 const r=await f.run([],{UNKNOWN_QUOTE:'1'});
 assert.equal(r.calls.length,0);assert.match(r.stderr,/price is unknown/);
});

test('uncertain uncapped submit can replay without its quote when no budget is requested',async t=>{
 const body={model:'test/image',input:{type:'text',prompt:'test'},parameters:{}};
 const f=await fixture(t,['old'],{jobs:{old:{idempotency_key:'original',body}}});
 const r=await f.run([],{},null);
 assert.equal(r.code,0);assert.deepEqual(r.calls,[body]);
});
test('status polling waits out a 429 per Retry-After',async t=>{
 const f=await fixture(t,['a']);const started=Date.now();const r=await f.run([],{RATE_LIMIT_STATUS:'1'});
 assert.equal(r.code,0);assert.match(r.stderr,/YIR_RATE_LIMITED/);assert.equal(r.state.jobs.a.status,'succeeded');
 const elapsed=Date.now()-started;assert.ok(elapsed>=1000&&elapsed<5000,`elapsed ${elapsed}ms`);
});


test('exact pixels pass through without synthesized resolution defaults', async t => {
 const f=await fixture(t,['exact']); const path=join(f.dir,'plan.json'); const plan=JSON.parse(await readFile(path,'utf8'));
 plan.jobs[0].params={size:'3136x1344'}; await writeFile(path,JSON.stringify(plan));
 const r=await f.run(); assert.equal(r.code,0); assert.deepEqual(r.calls[0].parameters,{size:'3136x1344'});
});
