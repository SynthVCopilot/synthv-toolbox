import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiService } from "../src/PiDesktop.Tauri/dist/electron/services/ai-service.js";
import { ModelRuntime } from "../packages/agent-runtime/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "toolbox-oauth-store-"));
try {
  const fake = {access:"fake-access",refresh:"fake-refresh",expires:Date.now()+3600000,accountId:"fake-account"};
  const ai = new AiService({
    metadataPath:join(root,"metadata.json"),runtime:{request:async()=>({})},catalog:{models:async()=>["gpt-5.6-terra"],opencode:async()=>({})},
    approvals:{cancelConversation(){}},authorizer:{authorize:async()=>({id:"test-account",label:"Test",secret:JSON.stringify(fake)})}
  });
  await ai.authorize_ai_provider("openai-codex");
  const resolved=await ai.resolveModelSelection();
  const selected={...resolved.credentials[0],credentialId:resolved.credentials[0].id};
  const store=ai.modelCredentialStore(selected);
  const runtime=await ModelRuntime.create({credentials:store,modelsPath:null,modelsStorePath:join(root,"models"),refreshOnCreate:true});
  const auth=await runtime.getAuth("openai-codex");
  assert.equal(auth.auth.apiKey,fake.access);
  assert.equal(runtime.isUsingOAuth("openai-codex"),true);
  assert.deepEqual(await store.list(),[{providerId:"openai-codex",type:"oauth"}]);
  assert.equal(await store.read("another-provider"),undefined);
  const second=ai.modelCredentialStore(selected),seen=[];
  await Promise.all([store,second].map((item,index)=>item.modify("openai-codex",async current=>{
    seen.push(current.access);return {...current,access:"rotated-"+index};
  })));
  assert.deepEqual(seen,["fake-access","rotated-0"]);
  assert.equal((await store.read("openai-codex")).access,"rotated-1");
  const bytes=await readFile(join(root,"metadata.json"),"utf8");
  assert.ok(!bytes.includes(fake.refresh));assert.ok(!bytes.includes("rotated-1"));
  await assert.rejects(store.delete("openai-codex"),/Toolbox settings/);
  const stopped=new AbortController();stopped.abort();
  await assert.rejects(store.read("openai-codex",{signal:stopped.signal}),/abort/i);
  await ai.remove_ai_provider_account("openai-codex","test-account");
  await assert.rejects(store.read("openai-codex"),/removed or disabled/);
  console.log("Real Pi Codex OAuth resolution uses the native encrypted store; concurrent refresh is serialized.");
} finally {await rm(root,{recursive:true,force:true});}
