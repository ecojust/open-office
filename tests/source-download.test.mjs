import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fetchSourceArchives, validateManifest } from '../scripts/fetch-corresponding-sources.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bytes=gzipSync(Buffer.from('owned fixture, no third-party code'));
const asset={file:'fixture.tar.gz',url:'https://example.com/fixture.tar.gz',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
const manifest={schemaVersion:1,archives:[asset]};
async function directory(t){const d=await mkdtemp(path.join(tmpdir(),'source-fetch-test-'));t.after(()=>rm(d,{recursive:true,force:true}));return d}
const quiet=()=>{};
test('verified download and subsequent offline validation never need a network call',async t=>{const d=await directory(t);await fetchSourceArchives({manifest,directory:d,fetchImpl:async()=>new Response(bytes),log:quiet});assert.deepEqual(await readFile(path.join(d,asset.file)),bytes);let calls=0;await fetchSourceArchives({manifest,directory:d,verifyOnly:true,fetchImpl:async()=>{calls++;throw Error('unexpected')},log:quiet});assert.equal(calls,0);assert.match(await readFile(path.join(d,'SHA256SUMS'),'utf8'),new RegExp(asset.sha256))});
test('missing archive cannot pass offline verification',async t=>{const d=await directory(t);await assert.rejects(fetchSourceArchives({manifest,directory:d,verifyOnly:true,log:quiet}),/Missing or damaged/);assert.deepEqual(await readdir(d),[])});
test('same-size corrupt archive cannot pass verification',async t=>{const d=await directory(t);await writeFile(path.join(d,asset.file),Buffer.alloc(bytes.length));await assert.rejects(fetchSourceArchives({manifest,directory:d,verifyOnly:true,log:quiet}),/Missing or damaged/)});
test('oversized network stream is rejected and partial is cleaned',async t=>{const d=await directory(t);await assert.rejects(fetchSourceArchives({manifest,directory:d,fetchImpl:async()=>new Response(Buffer.concat([bytes,Buffer.from('extra')])),log:quiet}),/exceeds recorded size/);assert.deepEqual(await readdir(d),[])});
test('digest mismatch never overwrites an existing file',async t=>{const d=await directory(t);const previous=Buffer.from('existing unusable file remains for inspection');await writeFile(path.join(d,asset.file),previous);await assert.rejects(fetchSourceArchives({manifest,directory:d,fetchImpl:async()=>new Response(Buffer.alloc(bytes.length)),log:quiet}),/verification failed/);assert.deepEqual(await readFile(path.join(d,asset.file)),previous);assert.deepEqual(await readdir(d),[asset.file])});
test('HTML response is rejected even if recorded size/digest were incorrectly copied',async t=>{const d=await directory(t);const html=Buffer.from('<html>antibot challenge</html>');const bad={schemaVersion:1,archives:[{...asset,bytes:html.length,sha256:createHash('sha256').update(html).digest('hex')}]};await assert.rejects(fetchSourceArchives({manifest:bad,directory:d,fetchImpl:async()=>new Response(html),log:quiet}),/verification failed/);assert.deepEqual(await readdir(d),[])});
test('failed HTTP download cannot generate a success checksum set',async t=>{const d=await directory(t);await assert.rejects(fetchSourceArchives({manifest,directory:d,fetchImpl:async()=>new Response('no',{status:503}),log:quiet}),/HTTP 503/);assert.deepEqual(await readdir(d),[])});
test('paths, duplicate filenames, insecure URLs, and floating commit refs are refused',()=>{for(const archives of [[{...asset,file:'../outside.tar.gz'}],[asset,asset],[{...asset,url:'http://example.com/file.tar.gz'}],[{...asset,commit:'a'.repeat(40),url:'https://example.com/main.tar.gz'}]])assert.throws(()=>validateManifest({schemaVersion:1,archives}));});

test('active source listing works offline after retirement of the old office runtime', async () => {
  const expected = JSON.parse(await readFile(new URL('../public/legal/corresponding-sources-manifest.json', import.meta.url), 'utf8'));
  const actual = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/fetch-corresponding-sources.mjs', import.meta.url)), '--list'], { encoding: 'utf8' }));
  assert.deepEqual(actual, expected);
  for (const retired of ['runtimeManifestSha256', 'runtimeAssetSha256', 'zetaJsShippedSha256', 'localRuntimeDerivations', 'localModificationMaterials']) assert.equal(retired in actual, false);
  assert.ok(actual.archives.every(entry => entry.bytes > 0 && /^[a-f0-9]{64}$/.test(entry.sha256)));
});
