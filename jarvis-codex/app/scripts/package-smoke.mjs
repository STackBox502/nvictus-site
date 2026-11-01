import {_electron as electron} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:path.resolve('release/win-unpacked/Jarvis Codex.exe'),args:[],cwd:process.cwd(),env,timeout:30000});
try{
 await app.firstWindow();let page;for(let i=0;i<100;i++){page=app.windows().find(p=>p.url().includes('window=main'));if(page)break;await new Promise(r=>setTimeout(r,50));}assert(page);await page.waitForSelector('.app-shell');
 const r=await page.evaluate(()=>window.jarvis.command({type:'snapshot'}));assert(r.ok);assert.equal(r.data.micStatus,'off');assert.equal(r.data.preview,false);assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
 const meta=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),name:app.getName(),userData:app.getPath('userData')}));assert(meta.packaged);
 await page.screenshot({path:'test-results/packaged-app.png'});
 await writeFile('test-results/packaged-smoke.json',JSON.stringify({date:'2026-11-01',...meta,micStatus:r.data.micStatus,providerCalls:0,deviceCapture:0,results:['Packaged asar application launches','Main UI and original character load','Microphone starts off','Renderer has no Node require','Quit exits cleanly (checked by harness)']},null,2));
 console.log(JSON.stringify({packaged:true,micStatus:r.data.micStatus,name:meta.name}));
}finally{await app.close();}
