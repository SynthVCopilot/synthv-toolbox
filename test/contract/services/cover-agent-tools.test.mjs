import assert from "node:assert/strict";
import { createCoverAgentToolsExtension } from "../../../src/PiDesktop.Tauri/dist/electron/services/cover-agent-tools.js";
const jobs=[],calls=[],guards=[],tools=[];
let runId="run-a";
const extension=createCoverAgentToolsExtension({
 sessionId:"parent-a",runState:()=>({active:true,runId}),guards:{completion:check=>guards.push(check)},
 invoke:async(command,args)=>{
  calls.push({command,args});
  if(command==="media_tasks")return structuredClone(jobs);
  if(command==="queue_cover"){const job={id:"job-1",status:"queued",stage:"queued",...args.request};jobs.push(job);return job;}
  const job=jobs.find(item=>item.id===args.id);
  if(command==="cancel_media_task")job.status="cancelled";
  if(command==="retry_media_task")job.status="running";
  return job;
 }
});
extension.factory({on(){},registerTool:tool=>tools.push(tool)});
const tool=tools[0],call=args=>tool.execute("call",args);
await assert.rejects(call({action:"status",taskId:"foreign"}),/does not belong/);
await assert.rejects(call({action:"start",source:"https://example.com/song",trackIndex:0}),/one-based/);
await call({action:"start",source:"https://example.com/song",trackIndex:1,rightsConfirmed:true});
assert.equal(jobs[0].parentConversationId,"parent-a");
assert.equal(jobs[0].parentRunId,"run-a");
assert.match(guards[0](),/queued/);
await assert.rejects(call({action:"start",source:"https://example.com/song",trackIndex:1}),/already exists/);
await assert.rejects(call({action:"status",taskId:"job-1",waitSeconds:301}),/between 0 and 300/);
const abort=new AbortController();
const updates=[];
const waiting=tool.execute("waiting",{action:"status",taskId:"job-1"},abort.signal,partial=>{updates.push(partial);abort.abort();});
await assert.rejects(waiting,/abort/i);
assert.equal(jobs[0].status,"cancelled");
assert.equal(updates[0].details.activity.status,"running");
assert.match(guards[0](),/queued|cancelled/);
await call({action:"retry",taskId:"job-1"});
jobs[0].status="completed";
await call({action:"status",taskId:"job-1"});
assert.equal(guards[0](),null);
await assert.rejects(call({action:"start",source:"https://example.com/song",trackIndex:1}),/already exists/);
runId="run-b";
await assert.rejects(call({action:"start",source:"https://example.com/song",trackIndex:1,parentConversationId:"foreign"}),/Unsupported/);
assert.equal(calls.filter(item=>item.command==="queue_cover").length,1);
console.log("Cover agent tools bind jobs, block false completion and cancel waiting work.");
