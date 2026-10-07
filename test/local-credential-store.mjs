import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createLocalCredentialStore } from '../src/PiDesktop.Tauri/dist/electron/services/local-credential-store.js';

test('local credentials persist across instances with random ciphertext and restricted files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'local-credentials-'));
 try{
  const store=createLocalCredentialStore(root),secret='fake-oauth-access-token';
  const [first,second]=await Promise.all([store.seal(secret),createLocalCredentialStore(root).seal(secret)]);
  assert.notEqual(first,second);assert.ok(!first.includes(secret));assert.equal(await createLocalCredentialStore(root).unseal(first),secret);assert.equal(await store.unseal(second),secret);
  const key=await readFile(join(root,'credentials.key'));assert.equal(key.length,32);
  if(process.platform!=='win32')assert.equal((await stat(join(root,'credentials.key'))).mode & 0o077,0);
  assert.deepEqual(await readFile(join(root,'credentials.key')),key);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('unrecognized or modified ciphertext never returns credentials or creates a missing key',async()=>{
 const root=await mkdtemp(join(tmpdir(),'local-credentials-corrupt-'));
 try{
  const store=createLocalCredentialStore(root);await assert.rejects(store.unseal('unrecognized-ciphertext'),/Sign in again/);
  await assert.rejects(stat(join(root,'credentials.key')), {code:'ENOENT'});
  const sealed=await store.seal('fake-secret');const raw=Buffer.from(sealed.slice('local1:'.length),'base64url');raw[raw.length-1]^=1;
  await assert.rejects(store.unseal('local1:'+raw.toString('base64url')),/Sign in again/);
  await rm(join(root,'credentials.key'));
  await assert.rejects(createLocalCredentialStore(root).unseal(sealed),/Sign in again/);
  await assert.rejects(stat(join(root,'credentials.key')), {code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('a damaged local key is not overwritten during a new credential write',async()=>{
 const root=await mkdtemp(join(tmpdir(),'local-credentials-key-'));
 try{const path=join(root,'credentials.key');await writeFile(path,'damaged');await assert.rejects(createLocalCredentialStore(root).seal('fake-secret'),/Invalid local credential key/);assert.equal(await readFile(path,'utf8'),'damaged');}
 finally{await rm(root,{recursive:true,force:true});}
});
test('credential writes reject symlink key targets',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'local-credentials-link-'));
 try{const outside=join(root,'outside');await writeFile(outside,Buffer.alloc(32,7));await symlink(outside,join(root,'credentials.key'));await assert.rejects(createLocalCredentialStore(root).seal('fake-secret'),/Invalid local credential key/);assert.deepEqual(await readFile(outside),Buffer.alloc(32,7));}
 finally{await rm(root,{recursive:true,force:true});}
});
