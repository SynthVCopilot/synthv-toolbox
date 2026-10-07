import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCoverHost, secondsToBlick } from '../src/PiDesktop.Tauri/electron/services/cover-host.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'cover-host-'));
  const projectFile = join(root, 'cover.svp'); await writeFile(projectFile, '{"library":[]}');
  const state = { notes: [], groupName: '', sessionToken: 'session', calls: [], tempos: [{position: 0, bpm: 120}], unknown: false, writes: 0 };
  const tool = name => ({name, inputSchema: {}, description: '', title: name, annotations: {}, async call(p) {
    state.calls.push({ name, ...structuredClone(p) });
    const args = p.args ?? {}; let result = {};
    if (p.action === 'get_time_axis') result = {tempoMarks: state.tempos, hasMore: false};
    else if (p.action === 'get_track_notes') {
      const index = args.groupIndex ?? 1, notes = index === 1 ? [] : state.notes;
      result = {groups: [{groupIndex: index, name: index === 1 ? 'main' : state.groupName, noteCount: notes.length, notes: notes.slice(args.offset, args.offset + args.limit).map((note,i)=>({...note,noteIndex:args.offset+i+1})), contextId: 'ctx' + state.calls.length }]};
    } else if (p.action === 'add_notes') {
      if (args.grouping === 'target') assert.equal(args.groupName, undefined, 'Group names are allowed only when creating a new group');
      else state.groupName = args.groupName;
      state.notes.push(...args.notes); state.writes++;
      result = state.unknown ? {outcome: 'unknown', error: {message: 'response lost'}} : {outcome:'changed', verified:true, groupIndex:2};
    } else if (name === 'sv_command') { state.writes++; result = {outcome:'changed', verified:true, changedCount:1}; }
    else result = {parameters: {breathiness: .1}, contextId:'voice-context'};
    return {isError: false, text: JSON.stringify(result)};
  }});
  const bridge = {tools:['sv_status','sv_query','sv_command','sv_ui','sv_describe'].map(tool), instructions:'', classify:()=>({category:'read',risk:'normal'}),status:async()=>({connected:true,status:{sessionToken:state.sessionToken,projectFile}}),close:async()=>{},requestStop:async()=>{}};
  const service = createCoverHost(bridge, {
    listProcesses: async () => [{isSv2:true,processId:7,processIdentity:'7:identity'}],
    sendShortcut: async (_id,_identity,action) => {assert.equal(action,'save'); await writeFile(projectFile,JSON.stringify({library:[{name:state.groupName,notes:state.notes}]})); return {succeeded:true};},
  });
  return {root,projectFile,state,service};
}
const score = count => Array.from({length:count},(_,i)=>({startSeconds:i*.25,endSeconds:i*.25+.2,pitch:60+i%5,lyric:i%2?'-':'a'}));
test('maps seconds across tempo changes without changing the host tempo',()=>{
  assert.equal(secondsToBlick(1,[{position:0,bpm:120}]),1411200000);
  assert.equal(secondsToBlick(2,[{position:0,bpm:120},{position:1411200000,bpm:60}]),2116800000);
  assert.throws(()=>secondsToBlick(-1,[{position:0,bpm:120}]),/Invalid/);
});
test('imports all 601 notes in bounded batches and verifies the saved full group',async()=>{
  const f=await fixture();try{
    const target=await f.service.prepare(1,'Long song','abc-job'), checkpoints=[];
    await f.service.importNotes(target,score(601),new AbortController().signal,async(t,dispatching)=>checkpoints.push({count:t.importedCount,dispatching}));
    assert.equal(target.importedCount,601); assert.equal(f.state.writes,11);
    assert.equal(f.state.calls.filter(c=>c.action==='add_notes').every(c=>c.args.notes.length<=60),true);
    assert.deepEqual(checkpoints.at(-1),{count:601,dispatching:false});
    assert.equal((await f.service.verify(target)).noteCount,601);
    assert.equal((await f.service.save(target)).saveVerified,true);
    assert.equal(JSON.parse(await readFile(f.projectFile,'utf8')).library[0].notes.length,601);
    await assert.rejects(f.service.importNotes(target,score(601),new AbortController().signal,async()=>{}),/cannot be replayed/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('unknown writes retain a dispatch checkpoint and cannot silently pass',async()=>{
  const f=await fixture();try{
    const target=await f.service.prepare(1,'Long song','unknown-job'), checkpoints=[]; f.state.unknown=true;
    await assert.rejects(f.service.importNotes(target,score(61),new AbortController().signal,async(t,d)=>checkpoints.push(d)),/response lost/);
    assert.deepEqual(checkpoints,[true]); assert.equal(f.state.notes.length,60); assert.equal(target.importedCount,0);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
test('tuning cannot escape its group or overwrite repaired note geometry',async()=>{
  const f=await fixture();try{
    const target=await f.service.prepare(1,'Bound song','bound-job'); await f.service.importNotes(target,score(3),new AbortController().signal,async()=>{});
    const monitor={readNotes:new Set(),writes:0,actions:[]}, bound=f.service.forTuning(target,monitor);
    const query=bound.tools.find(t=>t.name==='sv_query'), command=bound.tools.find(t=>t.name==='sv_command');
    await assert.rejects(query.call({action:'get_track_notes',args:{trackIndex:2}}),/bound/);
    const read=JSON.parse((await query.call({action:'get_track_notes',args:{offset:0,limit:3},contextMode:'writeIntent'})).text);
    const contextId=read.groups[0].contextId; assert.equal(monitor.readNotes.size,3);
    await assert.rejects(command.call({action:'edit_notes',contextId,args:{edits:[{noteIndex:1,changes:{pitch:72}}]}}),/before host tuning/);
    await assert.rejects(command.call({action:'delete_notes',contextId,args:{}}),/Only fresh/);
    await command.call({action:'edit_notes',contextId,args:{edits:[{noteIndex:1,changes:{detune:3}}]}});
    assert.equal(monitor.writes,1); assert.equal(monitor.actions.length,1);
    f.state.tempos[0].bpm=121;
    await assert.rejects(f.service.verify(target),/tempo map changed/);
  }finally{await rm(f.root,{recursive:true,force:true});}
});
