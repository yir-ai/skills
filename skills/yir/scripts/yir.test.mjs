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
    if(p.includes('/models/test/sfx')) data={operations:[{operation:'generate_sound_effect',input_modes:['text'],parameters:[{name:'duration',type:'integer',required:false,default:5,minimum:1,maximum:22},{name:'n',type:'integer',required:false,values:[1]}]}]};
    else if(p.includes('/models/')) data={operations:[{operation:'generate_image',input_modes:['text'],parameters:[{name:'size',type:'string',required:false,values:['3136x1344']}]},{operation:'generate_video',input_modes:['text','image','reference'],parameters:[{name:'fps',type:'integer',required:false,values:[24]}]},{operation:'generate_music',input_modes:['text'],parameters:[{name:'instrumental',type:'boolean',required:false,default:false},{name:'lyrics_optimizer',type:'boolean',required:false,default:false},{name:'duration',type:'integer',required:false,values:[30,60,120],default:60},{name:'n',type:'integer',required:false,values:[1,2]}]}]};
    else if(p.endsWith('/quotes')) { await appendFile(process.env.CALLS+'.paths',p+'\\n'); if ('max_cost' in JSON.parse(opts.body)) return new Response(JSON.stringify({error:{code:'YIR_INVALID_REQUEST',message:'max_cost is not allowed in this request.'}}),{status:400}); data=process.env.UNKNOWN_QUOTE==='1'?{primary:{amount:null},supply:{available:true}}:{expected_amount:'0.05',supply:{available:true}}; }
    else if(p.endsWith('/generations')) {
      await appendFile(process.env.CALLS,JSON.stringify(JSON.parse(opts.body))+'\\n'); await appendFile(process.env.CALLS+'.paths',p+'\\n');
      data={id:'2',status:'queued'};
    } else if(p.endsWith('/status')) {
      if(process.env.RATE_LIMIT_STATUS==='1' && !globalThis.limited) { globalThis.limited=true; return new Response(JSON.stringify({error:{code:'YIR_RATE_LIMITED',retryable:true}}),{status:429,headers:{'retry-after':'1'}}); }
      if(process.env.FAIL_STATUS==='1') return new Response(JSON.stringify({error:{code:'YIR_UNAUTHORIZED',retryable:false}}),{status:401});
      data={status:'succeeded'};
    }
    else if(p.startsWith('/v1/jobs/')) data={id:p.split('/').at(-1),status:'succeeded',billing:{status:process.env.PENDING_BILL==='1'?'pending':'settled',total_charged_by_yir:p.endsWith('/1')?'0.08':'0.05'},result:{availability:'available',files:process.env.MUSIC==='2'?[{url:'https://mock/asset',media_type:'audio/mpeg',duration_ms:150000},{url:'https://mock/asset',media_type:'audio/wav',duration_ms:140000}]:[process.env.MUSIC==='1'?{url:'https://mock/asset',media_type:'audio/mpeg',duration_ms:151230}:{url:'https://mock/asset',media_type:'image/png'}]}};
    else if(p==='/asset') return new Response('image',{status:process.env.FAIL_DOWNLOAD==='1'?503:200});
    else throw Error('unexpected '+p);
    return new Response(JSON.stringify(data));
  };`);
  return {dir, async run(extra=[], env={}, maxTotal="0.10") {
    let result;
    try { result=await exec(process.execPath,['--import',pathToFileURL(mock).href,script,'batch',plan,'--out',dir,...(maxTotal===null?[]:['--max-total',maxTotal]),...extra],{env:{...process.env,YIR_API_KEY:'mock',YIR_BASE_URL:'https://mock',CALLS:join(dir,'calls'),...env}});result.code=0; }
    catch(e){result=e;}
    const calls=await readFile(join(dir,'calls'),'utf8').catch(()=> '');
    const paths=await readFile(join(dir,'calls.paths'),'utf8').catch(()=> '');
    return {...result, paths:paths.trim()?paths.trim().split('\n'):[], state:JSON.parse(await readFile(join(dir,'.yir-batch.json'),'utf8')), calls:calls.trim()?calls.trim().split('\n').map(JSON.parse):[]};
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

test('native video fps passes through without a synthesized default', async t => {
 const f=await fixture(t,['explicit','omitted']); const path=join(f.dir,'plan.json'); const plan=JSON.parse(await readFile(path,'utf8'));
 plan.defaults.type='video'; plan.defaults.model='test/video'; plan.jobs[0].params={fps:24}; await writeFile(path,JSON.stringify(plan));
 const r=await f.run(['--concurrency','1']); assert.equal(r.code,0); assert.equal(r.calls.length,2);
 assert.deepEqual(r.calls[0].parameters,{fps:24}); assert.deepEqual(r.calls[1].parameters,{});
});

test('first-frame video can omit text without synthesizing a prompt', async t => {
 const f=await fixture(t,['image']); const path=join(f.dir,'plan.json'); const plan=JSON.parse(await readFile(path,'utf8'));
 plan.defaults.type='video'; delete plan.defaults.prompt; plan.jobs[0].image=['https://example.com/first.png']; await writeFile(path,JSON.stringify(plan));
 const r=await f.run(); assert.equal(r.code,0,r.stderr); assert.equal(r.calls[0].input.type,'image'); assert.equal(Object.hasOwn(r.calls[0].input,'prompt'),false);
});

async function musicPlan(f, job) {
 const path=join(f.dir,'plan.json'); const plan=JSON.parse(await readFile(path,'utf8'));
 plan.defaults.type='music'; plan.defaults.model='test/music'; Object.assign(plan.jobs[0],job); await writeFile(path,JSON.stringify(plan));
}
test('music job sends file lyrics to the music endpoints and saves an mp3 with its duration', async t => {
 const f=await fixture(t,['song']); await writeFile(join(f.dir,'song.txt'),'[Verse]\r\nline one\r\n');
 await musicPlan(f,{lyrics_file:'song.txt'});
 const r=await f.run([],{MUSIC:'1'}); assert.equal(r.code,0,r.stderr);
 assert.deepEqual(r.paths,['/v1/music/quotes','/v1/music/generations']);
 assert.deepEqual(r.calls[0].input,{type:'text',prompt:'test',lyrics:'[Verse]\nline one'});
 assert.deepEqual(r.state.jobs.song.files,['song.mp3']);
 const meta=JSON.parse(await readFile(join(f.dir,'song.json'),'utf8'));
 assert.equal(meta.lyrics,'[Verse]\nline one'); assert.deepEqual(meta.durations,[{file:'song.mp3',duration_ms:151230}]);
});
test('music lyrics rules are checked before quoting or submitting', async t => {
 for (const [job,msg] of [[{},/vocal music needs/],[{lyrics:'la',params:{instrumental:true}},/instrumental=true/],[{lyrics:'la',params:{lyrics_optimizer:true}},/lyrics_optimizer=true/],[{image:'https://example.com/a.png'},/no --image/]]) {
  const f=await fixture(t,['song']); await musicPlan(f,job);
  const r=await f.run(); assert.equal(r.code,2); assert.match(r.stderr,msg); assert.equal(r.calls.length,0); assert.deepEqual(r.paths,[]);
 }
 const f=await fixture(t,['song']); await musicPlan(f,{params:{instrumental:true}});
 const r=await f.run([],{MUSIC:'1'}); assert.equal(r.code,0,r.stderr); assert.deepEqual(r.calls[0].input,{type:'text',prompt:'test'}); assert.deepEqual(r.calls[0].parameters,{instrumental:true});
});
test('music command saves the track under --name with its measured duration', async t => {
 const f=await fixture(t,['unused']);
 const mock=join(f.dir,'mock.mjs');
 const r=await exec(process.execPath,['--import',pathToFileURL(mock).href,script,'music','-m','test/music','--prompt','lofi','--lyrics','hello','--name','track','--out',f.dir],{env:{...process.env,YIR_API_KEY:'mock',YIR_BASE_URL:'https://mock',CALLS:join(f.dir,'calls'),MUSIC:'1'}});
 const out=JSON.parse(r.stdout); assert.equal(out.files[0].duration_ms,151230); assert.match(out.files[0].path,/track\.mp3$/);
 assert.equal((await readFile(join(f.dir,'calls.paths'),'utf8')).trim(),'/v1/music/generations');
});
test('music duration from --duration and batch duration reaches parameters.duration', async t => {
 const f=await fixture(t,['long']); await musicPlan(f,{duration:120,params:{lyrics_optimizer:true}});
 const r=await f.run([],{MUSIC:'1'}); assert.equal(r.code,0,r.stderr); assert.deepEqual(r.calls[0].parameters,{lyrics_optimizer:true,duration:120});
 const mock=join(f.dir,'mock.mjs'); const env={...process.env,YIR_API_KEY:'mock',YIR_BASE_URL:'https://mock',CALLS:join(f.dir,'cli'),MUSIC:'1'};
 await exec(process.execPath,['--import',pathToFileURL(mock).href,script,'music','-m','test/music','--prompt','lofi','-p','instrumental=true','--duration','30','--out',f.dir],{env});
 assert.deepEqual(JSON.parse((await readFile(join(f.dir,'cli'),'utf8')).trim()).parameters,{instrumental:true,duration:30});
 await assert.rejects(()=>exec(process.execPath,['--import',pathToFileURL(mock).href,script,'music','-m','test/music','--prompt','lofi','-p','instrumental=true','--duration','45','--out',f.dir],{env}),e=>e.code===2 && /duration=45 is not allowed/.test(e.stderr));
});
test('sound effect runs through the music command without lyrics', async t => {
 const f=await fixture(t,['door']); await musicPlan(f,{model:'test/sfx',duration:3});
 const r=await f.run([],{MUSIC:'1'}); assert.equal(r.code,0,r.stderr);
 assert.deepEqual(r.paths,['/v1/music/quotes','/v1/music/generations']);
 assert.deepEqual(r.calls[0],{model:'test/sfx',input:{type:'text',prompt:'test'},parameters:{duration:3},max_cost:'0.050000'});
 for (const job of [{model:'test/sfx',lyrics:'la'},{model:'test/sfx',params:{instrumental:true}}]) {
  const g=await fixture(t,['door']); await musicPlan(g,job);
  const bad=await g.run(); assert.equal(bad.code,2); assert.equal(bad.calls.length,0);
 }
});
test('two-track result saves every audio file with its media-type extension', async t => {
 const f=await fixture(t,['pair']); await musicPlan(f,{params:{instrumental:true,n:2}});
 const r=await f.run([],{MUSIC:'2'}); assert.equal(r.code,0,r.stderr);
 assert.deepEqual(r.state.jobs.pair.files,['pair-1.mp3','pair-2.wav']);
 const meta=JSON.parse(await readFile(join(f.dir,'pair.json'),'utf8'));
 assert.deepEqual(meta.durations,[{file:'pair-1.mp3',duration_ms:150000},{file:'pair-2.wav',duration_ms:140000}]);
});
test('reference_image@NAME groups photos into a subject and rejects invalid names', async t => {
 const f=await fixture(t,['unused']);
 const mock=join(f.dir,'mock.mjs'); const env={...process.env,YIR_API_KEY:'mock',YIR_BASE_URL:'https://mock',CALLS:join(f.dir,'calls')};
 const base=[ '--import',pathToFileURL(mock).href,script,'video','-m','test/video','--prompt','@hero waves','--out',f.dir,'--no-wait'];
 await exec(process.execPath,[...base,'--ref','reference_image@hero=https://example.com/a.png','--ref','reference_image@hero=https://example.com/b.png'],{env});
 const call=JSON.parse((await readFile(join(f.dir,'calls'),'utf8')).trim().split('\n')[0]);
 assert.equal(call.input.type,'reference');
 assert.deepEqual(call.input.references,[{role:'reference_image',url:'https://example.com/a.png',subject:'hero'},{role:'reference_image',url:'https://example.com/b.png',subject:'hero'}]);
 for (const bad of ['reference_video@hero=https://example.com/a.mp4','reference_image@1hero=https://example.com/a.png','reference_image@a@b=https://example.com/a.png']) {
  await assert.rejects(()=>exec(process.execPath,[...base,'--ref',bad],{env}),e=>e.code===2,bad);
 }
});
