local ipc, executor = assert(arg[1]), assert(arg[2])
local prefix = ipc .. "/synthv-agent-bridge-sv1-legacy"
local requestFile, responseFile, statusFile = prefix..".request.json", prefix..".response.json", prefix..".status.json"
local scheduled, now, undoCount, statusWrites = {}, 1000, 0, 0
local realRename = os.rename
os.time = function() return math.floor(now / 1000) end
os.rename = function(from, to) if to == statusFile then statusWrites = statusWrites + 1 end return realRename(from, to) end

local function indexOf(values, wanted) for i,value in ipairs(values) do if value == wanted then return i end end end
local function note(onset, pitch)
  local value={onset=onset,duration=10,pitch=pitch,lyrics="la",phonemes=""}
  function value:getOnset() return self.onset end; function value:setOnset(v) self.onset=v; if self.parent then table.sort(self.parent.notes,function(a,b) return a:getOnset()<b:getOnset() end) end end
  function value:getDuration() return self.duration end; function value:setDuration(v) self.duration=v end
  function value:getPitch() return self.pitch end; function value:setPitch(v) self.pitch=v end
  function value:getLyrics() return self.lyrics end; function value:setLyrics(v) self.lyrics=v end
  function value:getPhonemes() return self.phonemes end; function value:setPhonemes(v) self.phonemes=v end
  return value
end
local function group()
  local value={name="Main",notes={note(20,60)}}; value.notes[1].parent=value
  function value:getName() return self.name end; function value:setName(v) self.name=v end
  function value:getNumNotes() return #self.notes end; function value:getNote(i) return self.notes[i] end
  function value:addNote(n) n.parent=self; table.insert(self.notes,n); table.sort(self.notes,function(a,b) return a:getOnset()<b:getOnset() end) end
  function value:removeNote(i) table.remove(self.notes,i) end
  return value
end
local function reference(target, main)
  local value={target=target,main=main,timeOffset=0,pitchOffset=0}
  function value:isInstrumental() return false end; function value:getTarget() return self.target end; function value:isMain() return self.main end
  function value:getTimeOffset() return self.timeOffset end; function value:setTimeOffset(v) self.timeOffset=v end
  function value:getPitchOffset() return self.pitchOffset end; function value:setPitchOffset(v) self.pitchOffset=v end
  function value:setTarget(v) self.target=v end
  return value
end
local function track()
  local main=reference(group(),true); local value={name="Track",groups={main}}
  function value:getName() return self.name end; function value:setName(v) self.name=v end
  function value:getNumGroups() return #self.groups end; function value:getGroupReference(i) return self.groups[i] end
  function value:addGroupReference(r) table.insert(self.groups,r); return #self.groups end; function value:removeGroupReference(i) table.remove(self.groups,i) end
  return value
end
local project={tracks={track()},library={}}
function project:getNumTracks() return #self.tracks end; function project:getTrack(i) return self.tracks[i] end
function project:addTrack(t) table.insert(self.tracks,t); return #self.tracks end; function project:removeTrack(i) table.remove(self.tracks,i) end
function project:addNoteGroup(g) table.insert(self.library,g); return #self.library end; function project:newUndoRecord() undoCount=undoCount+1 end
function project:getFileName() return "mock.svp" end
function project:getTimeAxis() return { getAllTempoMarks=function() return {{position=0,bpm=120}} end, getAllMeasureMarks=function() return {{position=0,numerator=4,denominator=4}} end } end
local playback={status="stopped",playhead=0}
function playback:getStatus() return self.status end; function playback:getPlayhead() return self.playhead end
function playback:play() self.status="playing" end; function playback:pause() self.status="stopped" end; function playback:stop() self.status="stopped"; self.playhead=0 end; function playback:seek(v) self.playhead=v end
local selection={hasUnfinishedEdits=function() return false end}
SV={}
function SV:getHostInfo() return {osType="Linux",hostVersion="1.11.2",hostVersionNumber=0x010B02} end
function SV:getProject() return project end; function SV:getMainEditor() return {getSelection=function() return selection end} end
function SV:getArrangement() return {getSelection=function() return selection end} end; function SV:getPlayback() return playback end
function SV:create(kind) if kind=="Track" then return track() elseif kind=="NoteGroup" then return group() elseif kind=="NoteGroupReference" then return reference(nil,false) elseif kind=="Note" then return note(0,60) end error("unsupported "..kind) end
function SV:setTimeout(_, callback) table.insert(scheduled, callback) end; function SV:finish() end
dofile(executor)
main()
local function step() local callback=table.remove(scheduled,1); assert(callback,"no scheduled poll"); callback() end
local function write(path,value) local f=assert(io.open(path,"wb")); f:write(value); f:close() end
local function read(path) local f=assert(io.open(path,"rb")); local v=f:read("*a"); f:close(); return v end
local serial=0
local function call(action,payload)
  serial=serial+1; write(requestFile,string.format('{"v":1,"id":"r%d","a":"%s","p":%s}',serial,action,payload or "{}")); step(); return read(responseFile)
end
assert(read(statusFile):match('"state":"running"')); local initialWrites=statusWrites
for _=1,10 do step() end; assert(statusWrites==initialWrites,"heartbeat wrote every poll")
now=now+1000; step(); assert(statusWrites==initialWrites+1,"heartbeat did not write at one second")
assert(call("studio.get_status"):match('"host":"sv1"'))
assert(call("project.get"):match('"trackCount":1'))
local sequence=call("sequence.get"); assert(sequence:match('"tempoMarks"') and sequence:match('"timeSignatures"') and not sequence:match('"tracks"'))
assert(call("track.list"):match('"trackIndex":0'))
local createdPart=call("part.create",'{"trackIndex":0,"name":"Offset","timeOffset":30,"pitchOffset":2,"writeIntent":true}'); assert(createdPart:match('"partIndex":1'),createdPart); assert(createdPart:match('"timeOffset":30'))
local created=call("note.create",'{"trackIndex":0,"partIndex":0,"onset":10,"duration":5,"pitch":62,"writeIntent":true}'); assert(created:match('"noteIndex":0'),created)
local updated=call("note.update",'{"trackIndex":0,"partIndex":0,"noteIndex":1,"onset":5,"writeIntent":true}'); assert(updated:match('"noteIndex":0'),updated)
assert(call("track.delete",'{"trackIndex":0,"writeIntent":true}'):match('LAST_TRACK_FORBIDDEN'))
assert(call("transport.seek",'{"seconds":3,"writeIntent":true}'):match('"playheadSeconds":3'))
assert(undoCount>=3,"project writes did not open Undo records")
print("SV1_LEGACY_MOCK_OK")
