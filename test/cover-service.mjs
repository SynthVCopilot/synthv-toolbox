import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCoverService } from '../src/PiDesktop.Tauri/electron/services/cover-service.ts';

async function fixture({unknown=false,failDownload=false}={}) {
  const root=await mkdtemp(join(tmpdir(),'cover-queue-')), svp=join(root,'song.svp'), notesPath=join(root,'notes.json');
  await writeFile(svp,'{}');const notes=[{startSeconds:0,endSeconds:1,pitch:60,lyric:'a'}];
  const bytes=JSON.stringify({timingBasis:'seconds',noteCount:1,notes});await writeFile(notesPath,bytes);
  const hash=createHash('sha256').update(bytes).digest('hex');
  const events=[],counts={downloads:0,imports:0,separate:0};let seq=0,service;
  const repaired={notesPath,sha256:hash,noteCount:1,issues:[],changes:[],accepted:true};
  const score={prepare:async()=>events.push('prepare'),accept:async()=>events.push('accept'),result:async()=>repaired,finalize:async()=>({complete:true,reviewed:1,noteCount:1,unresolved:[]})};
  const opts={dataRoot:root,runtime:{ensure:async()=>'/python'},score,
    importer:async()=>({preview:async()=>({title:'Source'}),importSource:async()=>{counts.downloads++;if(failDownload&&counts.downloads===1)throw Error('network unavailable');return {source:{title:'Source'},audioPath:'/audio.wav'};}}),
    audio:()=>({separate:async()=>{counts.separate++;return {vocalPath:'/vocal.wav',instrumentalPath:'/ins.wav',device:'mps'};},transcribeAndExtract:async()=>({notesPath,notesSha256:hash,noteCount:1,rawNoteCount:1,durationSeconds:1,language:'en'})}),
    host:{prepare:async(trackIndex,groupName)=>{assert.equal(typeof groupName,'string');assert.equal(trackIndex,1);return {projectFile:svp,trackIndex,groupName,notes:[],importedCount:0};},importNotes:async(target,input,signal,checkpoint)=>{counts.imports++;await checkpoint(target,true);if(unknown)throw Error('unknown write outcome');target.notes=input;target.importedCount=input.length;target.groupIndex=2;await checkpoint(target,false);},verify:async()=>({noteCount:1}),save:async()=>({svpPath:svp,saveVerified:true})},
    ai:()=>({ai_provider_state:async()=>({activeProvider:'provider',providers:[{id:'provider',connected:true,model:'current-model'}]}),new_conversation:async()=>({id:'conversation-'+(++seq)}),cancel_agent_run:async()=>{},send_message:async id=>{const binding=service.session(id);events.push(binding.phase);if(binding.monitor){binding.monitor.readNotes.add(1);binding.monitor.writes++;}return [{role:'assistant',content:'Verified.',outcome:{status:'completed'}}];}})};
  service=createCoverService(opts);return {root,service,opts,events,counts};
}
const request={source:'https://www.bilibili.com/video/BV1QQ4y1E73r/',rightsConfirmed:true,trackIndex:1,groupName:'Cover',voiceName:''};
async function finish(service,id){for(let i=0;i<200;i++){const job=(await service.invoke('media_tasks',{})).find(j=>j.id===id);if(['completed','failed','cancelled'].includes(job.status))return job;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}
test('repairs first, imports the accepted score, then performs real monitored tuning and saves',async()=>{
 const f=await fixture();try{const queued=await f.service.invoke('queue_cover',{request});assert.equal(queued.status,'queued');const done=await finish(f.service,queued.id);assert.equal(done.status,'completed',done.error);assert.deepEqual(f.events,['prepare','repair','accept','tuning']);assert.equal(done.result.tuning.notesReviewed,1);assert.equal(done.result.tuning.verifiedWrites,1);assert.equal(done.result.renderStatus,'not_rendered');assert.equal(done.result.saveVerified,true);assert.equal(done.retryable,false);assert.ok((await readFile(done.result.reportPath)).length>0);}finally{await f.service.dispose();await rm(f.root,{recursive:true,force:true});}
});
test('local failures can retry, but uncertain host writes never automatically replay',async()=>{
 const local=await fixture({failDownload:true});try{const job=await local.service.invoke('queue_cover',{request:{...request,groupName:undefined}});assert.equal((await finish(local.service,job.id)).status,'failed');await local.service.invoke('retry_media_task',{id:job.id});assert.equal((await finish(local.service,job.id)).status,'completed');assert.equal(local.counts.downloads,2);assert.equal(local.counts.imports,1);}finally{await local.service.dispose();await rm(local.root,{recursive:true,force:true});}
 const host=await fixture({unknown:true});try{const job=await host.service.invoke('queue_cover',{request});const failed=await finish(host.service,job.id);assert.equal(failed.retryable,false);await assert.rejects(host.service.invoke('retry_media_task',{id:job.id}),/不能自动重试/);assert.equal(host.counts.imports,1);const restored=createCoverService(host.opts);assert.equal((await restored.invoke('media_tasks',{}))[0].retryable,false);await restored.dispose();}finally{await host.service.dispose();await rm(host.root,{recursive:true,force:true});}
});
test('cancelling processing aborts its process signal and never starts host writes',async()=>{
 const f=await fixture();let observed=false;f.opts.runtime.ensure=({signal})=>new Promise((_,reject)=>{observed=true;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});try{const job=await f.service.invoke('queue_cover',{request});for(let i=0;!observed&&i<100;i++)await new Promise(r=>setTimeout(r,5));await f.service.invoke('cancel_media_task',{id:job.id});assert.equal((await finish(f.service,job.id)).status,'cancelled');assert.equal(f.counts.imports,0);}finally{await f.service.dispose();await rm(f.root,{recursive:true,force:true});}
});
