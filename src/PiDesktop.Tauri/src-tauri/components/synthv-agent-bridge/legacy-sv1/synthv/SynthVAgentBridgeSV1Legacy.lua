-- Synthesizer V Studio Pro 1.11.2 executor. It deliberately shares no files or IPC names with the SV2 bridge.
local SCRIPT_NAME = "SynthV Agent Bridge SV1 Legacy"
local MIN_EDITOR_VERSION = 0x010B02
local PROTOCOL_VERSION = 1
local POLL_INTERVAL_MS = 40
local HEARTBEAT_INTERVAL_MS = 1000
local MAX_REQUEST_BYTES = 256 * 1024

local function hostInfo() return SV:getHostInfo() end
local function join(a, b)
  local separator = hostInfo().osType == "Windows" and "\\" or "/"
  return (a:gsub("[/\\]+$", "")) .. separator .. b
end
local function ipcDirectory()
  local configured = os.getenv("SYNTHV_AGENT_SV1_LEGACY_DIR")
  if configured and configured ~= "" then return configured end
  if hostInfo().osType == "Windows" then return os.getenv("TEMP") or os.getenv("TMP") or "." end
  return os.getenv("TMPDIR") or os.getenv("TMP") or os.getenv("TEMP") or "/tmp"
end
local PREFIX = join(ipcDirectory(), "synthv-agent-bridge-sv1-legacy")
local REQUEST_FILE, RESPONSE_FILE = PREFIX .. ".request.json", PREFIX .. ".response.json"
local STATUS_FILE, STOP_FILE = PREFIX .. ".status.json", PREFIX .. ".stop"
local lastHeartbeatEpochMs, lastStatusState, lastStatusMessage = 0, nil, nil

-- Compact JSON implementation: the bridge accepts only JSON values and never evaluates request text as Lua.
local json = {}
local function esc(s) return '"' .. s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', '\\r'):gsub('\t', '\\t') .. '"' end
function json.encode(v)
  if v == nil then return "null" end
  local t = type(v)
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then if v ~= v or v == math.huge or v == -math.huge then error("non-finite JSON number") end return tostring(v) end
  if t == "string" then return esc(v) end
  if t ~= "table" then error("unsupported JSON value") end
  local array, count = true, 0
  for k, _ in pairs(v) do count = count + 1; if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then array = false break end end
  if array then
    local result = {}; for i = 1, count do result[i] = json.encode(v[i]) end; return "[" .. table.concat(result, ",") .. "]"
  end
  local result = {}; for k, value in pairs(v) do if type(k) ~= "string" then error("JSON key is not string") end result[#result + 1] = esc(k) .. ":" .. json.encode(value) end; return "{" .. table.concat(result, ",") .. "}"
end
function json.decode(source)
  local index, length = 1, #source
  local function space() while index <= length and source:sub(index,index):match("%s") do index = index + 1 end end
  local function value()
    space(); local first = source:sub(index,index)
    if first == '"' then
      index = index + 1; local out = {}
      while index <= length do local c = source:sub(index,index); index = index + 1; if c == '"' then return table.concat(out) end; if c == "\\" then local e = source:sub(index,index); index = index + 1; local map = { ['"']='"', ['\\']='\\', ['/']='/', b='\b', f='\f', n='\n', r='\r', t='\t' }; if e == 'u' then error("unicode escapes are not supported by this legacy executor") end; if not map[e] then error("invalid JSON escape") end; out[#out+1]=map[e] else out[#out+1]=c end end; error("unterminated JSON string")
    elseif first == "{" then
      index=index+1; local out={}; space(); if source:sub(index,index)=="}" then index=index+1 return out end
      while true do space(); if source:sub(index,index)~='"' then error("object key expected") end; local key=value(); space(); if source:sub(index,index)~=":" then error("colon expected") end; index=index+1; out[key]=value(); space(); local c=source:sub(index,index); if c=="}" then index=index+1 return out end; if c~="," then error("object delimiter expected") end; index=index+1 end
    elseif first == "[" then
      index=index+1; local out={}; space(); if source:sub(index,index)=="]" then index=index+1 return out end
      while true do out[#out+1]=value(); space(); local c=source:sub(index,index); if c=="]" then index=index+1 return out end; if c~="," then error("array delimiter expected") end; index=index+1 end
    elseif source:sub(index,index+3)=="true" then index=index+4 return true
    elseif source:sub(index,index+4)=="false" then index=index+5 return false
    elseif source:sub(index,index+3)=="null" then index=index+4 return nil
    end
    local token=source:sub(index):match("^-?%d+%.?%d*[eE]?[-+]?%d*"); if not token or token=="" then error("JSON value expected") end; index=index+#token; return tonumber(token)
  end
  local result=value(); space(); if index<=length then error("trailing JSON data") end; return result
end

local function exists(path) local f=io.open(path,"rb"); if f then f:close(); return true end return false end
local function remove(path) if exists(path) then os.remove(path) end end
local function read(path) local f=io.open(path,"rb"); if not f then return nil end; local value=f:read("*a"); f:close(); if #value>MAX_REQUEST_BYTES then error("request exceeds limit") end return value end
local function write(path, value) local tmp=path.."."..tostring(os.time())..".tmp"; local f,err=io.open(tmp,"wb"); if not f then error(err) end; f:write(json.encode(value).."\n"); f:close(); remove(path); assert(os.rename(tmp,path)) end
local function fail(code, message) error({ code=code, message=message }, 0) end
local function object(value, name) if type(value) ~= "table" then fail("INVALID_ARGUMENT", name.." must be an object") end return value end
local function integer(value, name, minimum, maximum) if type(value)~="number" or value%1~=0 or value<minimum or value>maximum then fail("INVALID_ARGUMENT", name.." is out of range") end return value end
local function pendingEdits()
  local editor=SV:getMainEditor(); local arrangement=SV:getArrangement();
  return (editor:getSelection() and editor:getSelection():hasUnfinishedEdits()) or (arrangement:getSelection() and arrangement:getSelection():hasUnfinishedEdits())
end
local function project() local p=SV:getProject(); if not p then fail("PROJECT_UNAVAILABLE","No project is open") end return p end
local function track(p, zero) return p:getTrack(integer(zero,"trackIndex",0,p:getNumTracks()-1)+1) end
local function part(t, zero) return t:getGroupReference(integer(zero,"partIndex",0,t:getNumGroups()-1)+1) end
local function group(reference) if reference:isInstrumental() then fail("UNSUPPORTED_PART","Instrumental parts are not supported") end; local result=reference:getTarget(); if not result then fail("PART_NOT_FOUND","Part target is unavailable") end return result end
local function note(g, zero) return g:getNote(integer(zero,"noteIndex",0,g:getNumNotes()-1)+1) end
local function noteIndex(g, target)
  for index=1,g:getNumNotes() do
    local candidate=g:getNote(index)
    if candidate == target then return index-1 end
  end
  for index=1,g:getNumNotes() do
    local candidate=g:getNote(index)
    if candidate:getOnset()==target:getOnset() and candidate:getDuration()==target:getDuration() and candidate:getPitch()==target:getPitch() and candidate:getLyrics()==target:getLyrics() and candidate:getPhonemes()==target:getPhonemes() then return index-1 end
  end
  fail("HOST_POSTCONDITION_FAILED", "SynthV did not retain the modified note")
end
local function serialNote(n, i) return { noteIndex=i, onset=n:getOnset(), duration=n:getDuration(), pitch=n:getPitch(), lyrics=n:getLyrics(), phonemes=n:getPhonemes() } end
local function serialPart(r, i) local g=group(r); local notes={}; for n=1,g:getNumNotes() do notes[#notes+1]=serialNote(g:getNote(n),n-1) end; return { partIndex=i, name=g:getName(), main=r:isMain(), timeOffset=r:getTimeOffset(), pitchOffset=r:getPitchOffset(), notes=notes } end
local function serialTrack(t, i) local parts={}; for p=1,t:getNumGroups() do parts[#parts+1]=serialPart(t:getGroupReference(p),p-1) end; return { trackIndex=i, name=t:getName(), parts=parts } end
local function writeAllowed(payload) if payload.writeIntent ~= true then fail("WRITE_INTENT_REQUIRED","Write operations require writeIntent=true") end; if pendingEdits() then fail("HOST_EDIT_IN_PROGRESS","Finish or cancel the active SynthV edit before writing") end end
local function undo(p, payload) writeAllowed(payload); p:newUndoRecord() end
local handlers={}
handlers["studio.get_status"] = function() return { host="sv1", hostVersion=hostInfo().hostVersion, hostVersionNumber=hostInfo().hostVersionNumber, connected=true, capabilities={ singerAssignment=false, retakes=false, computedPitch=false, seek=true } } end
handlers["project.get"] = function() local p=project(); return { trackCount=p:getNumTracks(), fileName=p:getFileName() } end
handlers["sequence.get"] = function()
  local axis=project():getTimeAxis()
  return { tempoMarks=axis:getAllTempoMarks(), timeSignatures=axis:getAllMeasureMarks() }
end
handlers["track.list"] = function() local p=project(); local tracks={}; for i=1,p:getNumTracks() do tracks[#tracks+1]=serialTrack(p:getTrack(i),i-1) end; return tracks end
handlers["track.get"] = function(payload) local p=project(); return serialTrack(track(p,payload.trackIndex),payload.trackIndex) end
handlers["track.create"] = function(payload) local p=project(); undo(p,payload); local t=SV:create("Track"); t:setName(type(payload.name)=="string" and payload.name or "Track"); p:addTrack(t); return serialTrack(t,p:getNumTracks()-1) end
handlers["track.update"] = function(payload) local p=project(); undo(p,payload); local t=track(p,payload.trackIndex); if type(payload.name)~="string" then fail("INVALID_ARGUMENT","name is required") end; t:setName(payload.name); return serialTrack(t,payload.trackIndex) end
handlers["track.delete"] = function(payload) local p=project(); local index=integer(payload.trackIndex,"trackIndex",0,p:getNumTracks()-1); if p:getNumTracks()<=1 then fail("LAST_TRACK_FORBIDDEN","SynthV projects must retain one track") end; undo(p,payload); p:removeTrack(index+1); return { deleted=true, trackIndex=index } end
handlers["part.list"] = function(payload) local t=track(project(),payload.trackIndex); local result={}; for i=1,t:getNumGroups() do result[#result+1]=serialPart(t:getGroupReference(i),i-1) end; return result end
handlers["part.get"] = function(payload) return serialPart(part(track(project(),payload.trackIndex),payload.partIndex),payload.partIndex) end
handlers["part.create"] = function(payload)
  local p=project(); local t=track(p,payload.trackIndex); undo(p,payload)
  local g=SV:create("NoteGroup"); g:setName(type(payload.name)=="string" and payload.name or "Part")
  p:addNoteGroup(g); local r=SV:create("NoteGroupReference"); r:setTarget(g)
  if payload.timeOffset~=nil then r:setTimeOffset(integer(payload.timeOffset,"timeOffset",0,9007199254740991)) end
  if payload.pitchOffset~=nil then r:setPitchOffset(integer(payload.pitchOffset,"pitchOffset",-127,127)) end
  t:addGroupReference(r)
  return serialPart(r,t:getNumGroups()-1)
end
handlers["part.update"] = function(payload)
  local p=project(); local r=part(track(p,payload.trackIndex),payload.partIndex); local g=group(r); undo(p,payload)
  if payload.name==nil and payload.timeOffset==nil and payload.pitchOffset==nil then fail("INVALID_ARGUMENT","name, timeOffset, or pitchOffset is required") end
  if payload.name~=nil then if type(payload.name)~="string" then fail("INVALID_ARGUMENT","name must be a string") end; g:setName(payload.name) end
  if payload.timeOffset~=nil then r:setTimeOffset(integer(payload.timeOffset,"timeOffset",0,9007199254740991)) end
  if payload.pitchOffset~=nil then r:setPitchOffset(integer(payload.pitchOffset,"pitchOffset",-127,127)) end
  return serialPart(r,payload.partIndex)
end
handlers["part.delete"] = function(payload)
  local p=project(); local t=track(p,payload.trackIndex); local index=integer(payload.partIndex,"partIndex",0,t:getNumGroups()-1)
  if index==0 then fail("UNSUPPORTED_OPERATION","The SV1 main part cannot be deleted") end
  undo(p,payload); t:removeGroupReference(index+1); return { deleted=true, trackIndex=payload.trackIndex, partIndex=index }
end
handlers["note.list"] = function(payload) return serialPart(part(track(project(),payload.trackIndex),payload.partIndex),payload.partIndex).notes end
handlers["note.create"] = function(payload) local p=project(); local g=group(part(track(p,payload.trackIndex),payload.partIndex)); undo(p,payload); local n=SV:create("Note"); n:setOnset(integer(payload.onset,"onset",0,9007199254740991)); n:setDuration(integer(payload.duration,"duration",1,9007199254740991)); n:setPitch(integer(payload.pitch,"pitch",0,127)); n:setLyrics(type(payload.lyrics)=="string" and payload.lyrics or "la"); if type(payload.phonemes)=="string" then n:setPhonemes(payload.phonemes) end; g:addNote(n); return serialNote(n,noteIndex(g,n)) end
handlers["note.update"] = function(payload) local p=project(); local g=group(part(track(p,payload.trackIndex),payload.partIndex)); local n=note(g,payload.noteIndex); undo(p,payload); if payload.onset~=nil then n:setOnset(integer(payload.onset,"onset",0,9007199254740991)) end; if payload.duration~=nil then n:setDuration(integer(payload.duration,"duration",1,9007199254740991)) end; if payload.pitch~=nil then n:setPitch(integer(payload.pitch,"pitch",0,127)) end; if payload.lyrics~=nil then if type(payload.lyrics)~="string" then fail("INVALID_ARGUMENT","lyrics must be a string") end n:setLyrics(payload.lyrics) end; if payload.phonemes~=nil then if type(payload.phonemes)~="string" then fail("INVALID_ARGUMENT","phonemes must be a string") end n:setPhonemes(payload.phonemes) end; return serialNote(n,noteIndex(g,n)) end
handlers["note.delete"] = function(payload) local p=project(); local g=group(part(track(p,payload.trackIndex),payload.partIndex)); local index=integer(payload.noteIndex,"noteIndex",0,g:getNumNotes()-1); undo(p,payload); g:removeNote(index+1); return { deleted=true, trackIndex=payload.trackIndex, partIndex=payload.partIndex, noteIndex=index } end
handlers["transport.get"] = function() local c=SV:getPlayback(); return { status=c:getStatus(), playheadSeconds=c:getPlayhead() } end
handlers["transport.play"] = function(payload) writeAllowed(payload); SV:getPlayback():play(); return handlers["transport.get"]() end
handlers["transport.pause"] = function(payload) writeAllowed(payload); SV:getPlayback():pause(); return handlers["transport.get"]() end
handlers["transport.stop"] = function(payload) writeAllowed(payload); SV:getPlayback():stop(); return handlers["transport.get"]() end
handlers["transport.seek"] = function(payload) writeAllowed(payload); SV:getPlayback():seek(payload.seconds); return handlers["transport.get"]() end

local function status(state, message, force)
  local now=os.time()*1000
  if not force and state==lastStatusState and message==lastStatusMessage and now-lastHeartbeatEpochMs<HEARTBEAT_INTERVAL_MS then return false end
  write(STATUS_FILE,{ v=PROTOCOL_VERSION,state=state,updatedAtEpochMs=now,host=hostInfo(),message=message })
  lastHeartbeatEpochMs,lastStatusState,lastStatusMessage=now,state,message
  return true
end
local function process()
  if not exists(REQUEST_FILE) then return end
  local raw=read(REQUEST_FILE); remove(REQUEST_FILE); local request=json.decode(raw)
  local ok,result=pcall(function()
    object(request,"request"); if request.v~=PROTOCOL_VERSION or type(request.id)~="string" or type(request.a)~="string" then fail("PROTOCOL_MISMATCH","Malformed legacy request") end
    local handler=handlers[request.a]; if not handler then fail("UNSUPPORTED_OPERATION","Unsupported by Synthesizer V Studio Pro 1.11.2") end
    return handler(object(request.p or {},"payload"))
  end)
  if ok then write(RESPONSE_FILE,{v=PROTOCOL_VERSION,id=request.id,ok=true,result=result}) else local e=type(result)=="table" and result or {code="HOST_ERROR",message=tostring(result)}; write(RESPONSE_FILE,{v=PROTOCOL_VERSION,id=request.id,ok=false,error=e}) end
  status("running","",true)
end
local function poll() if exists(STOP_FILE) then remove(STOP_FILE); status("stopped","Stopped",true); SV:finish(); return end; local ok,err=pcall(process); if not ok then status("error",tostring(err),true) else status("running","",false) end; SV:setTimeout(POLL_INTERVAL_MS,poll) end
function getClientInfo() return { name=SCRIPT_NAME,author="SynthV Agent Bridge",category="SynthV Agent Bridge",versionNumber=1,minEditorVersion=MIN_EDITOR_VERSION } end
function main() remove(STOP_FILE); remove(REQUEST_FILE); remove(RESPONSE_FILE); status("running",""); poll() end
