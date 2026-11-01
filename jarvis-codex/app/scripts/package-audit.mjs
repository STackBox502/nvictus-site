import {listPackage,extractFile} from '@electron/asar';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
const archive='release/win-unpacked/resources/app.asar';
const files=listPackage(archive).map(f=>f.replaceAll('\\','/'));
const forbidden=files.filter(f=>/(^|\/)(\.env(?:\..*)?|test-results|tests|memories\.json|history\.json|credentials|\.venv)(\/|$)/.test(f));assert.deepEqual(forbidden,[]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const master=await readFile('../assets/jarvis-character.png');assert.equal(hash(extractFile(archive,path.normalize('dist/renderer/jarvis-character.png'))),hash(master));assert.equal(hash(extractFile(archive,path.normalize('dist/main.cjs'))),hash(await readFile('dist/main.cjs')));
const leaked=files.filter(f=>/\.(c?js|json|html|css)$/.test(f)).filter(f=>{const text=extractFile(archive,path.normalize(f.replace(/^\//,''))).toString();return text.includes('fixture-not-a-real-api-key')||/sk-(?:proj-)?[A-Za-z0-9_-]{32,}/.test(text);});assert.deepEqual(leaked,[]);
const {version}=JSON.parse(await readFile('package.json','utf8'));
const outputs=[];for(const name of [`Jarvis-Codex-${version}-portable.exe`,`Jarvis-Codex-${version}-setup.exe`,'win-unpacked/Jarvis Codex.exe']){const file=`release/${name}`,bytes=await readFile(file);assert.equal(bytes.subarray(0,2).toString(),'MZ');outputs.push({path:file,bytes:(await stat(file)).size,sha256:hash(bytes)});}
const report={date:'2026-11-01',verifierNode:process.version,files:files.length,forbiddenFiles:forbidden,knownSecretPatterns:leaked,masterAssetSha256:hash(master),mainBundleMatches:true,outputs,limitations:'Pattern scan is not a universal proof of absence. No real credentials were used during this build.'};await writeFile('test-results/package-audit.json',JSON.stringify(report,null,2));await writeFile('release/SHA256SUMS.txt',outputs.map(o=>`${o.sha256}  ${o.path.replace('release/','')}`).join('\n')+'\n');console.log(JSON.stringify(report,null,2));
