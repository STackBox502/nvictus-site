import {_electron as electron,expect} from '@playwright/test';
import electronPath from 'electron';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';

const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await electron.launch({executablePath:electronPath,args:['.','--test-mode'],cwd:process.cwd(),env,timeout:30000});
const fixture='fixture-clipboard-only-not-an-api-key';
const results=[];
try{
 await app.firstWindow();let page;
 await expect.poll(()=>{page=app.windows().find(p=>p.url().includes('window=main'));return !!page;}).toBe(true);
 await page.waitForSelector('.app-shell');
 const profile=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged,userData:app.getPath('userData')}));
 assert(profile.userData.includes('test-results'),'Clipboard check must use an isolated profile');
 await app.evaluate(async({clipboard,ClipboardItem,Menu,BrowserWindow},fixture)=>{
  // Original clipboard objects stay in this process's memory and are never logged.
  const original=[];
  for(const item of await clipboard.read()){
   const values={};for(const type of item.types)values[type]=await item.getType(type);
   original.push(new ClipboardItem(values));
  }
  globalThis.__editTest={original,owned:new Set([fixture]),popup:Menu.prototype.popup};
  Menu.prototype.popup=function(options){globalThis.__editTest.menu=this;globalThis.__editTest.window=options.window;};
  await clipboard.writeText(fixture);
  BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('window=main')).focus();
 },fixture);
 const nativeMenu=await app.evaluate(({Menu})=>Menu.getApplicationMenu()?.items.find(i=>i.label==='&Edit')?.submenu?.items.map(i=>i.role));
 for(const role of ['undo','redo','cut','copy','paste','selectall'])assert(nativeMenu.includes(role));
 results.push('Native Edit menu provides standard keyboard editing roles');
 async function chooseContext(field,role){
  await app.evaluate(()=>{globalThis.__editTest.menu=null;});
  await field.click({button:'right'});
  await expect.poll(()=>app.evaluate(()=>!!globalThis.__editTest.menu)).toBe(true);
  const activated=await app.evaluate((_electron,role)=>{
   const test=globalThis.__editTest,item=test.menu.items.find(i=>i.role===role.toLowerCase());
   if(!item?.enabled)return false;
   // Native role dispatch is internal to Electron; exercise its documented
   // webContents editing command after checking the constructed role and flags.
   test.window.webContents[role]();return true;
  },role);
  assert(activated,`${role} is available in the native context menu`);
 }
 await page.getByRole('button',{name:'Connections',exact:true}).click();
 for(const provider of ['Claude','OpenAI','ElevenLabs']){
  const field=page.getByLabel(`${provider} API key`,{exact:true});
  await field.click();await field.press('Control+V');await expect(field).toHaveValue(fixture);
  await field.press('Control+A');await field.press('Backspace');
  await chooseContext(field,'paste');await expect(field).toHaveValue(fixture);
  assert.equal(await field.getAttribute('type'),'password');
  await field.fill('');results.push(`${provider}: Ctrl+V, native Paste command, and right-click Paste availability; key remains masked and unsaved`);
 }
 const voice=page.getByLabel('Or enter your permitted voice ID',{exact:true});
 await chooseContext(voice,'paste');await expect(voice).toHaveValue(fixture);
 results.push('Voice ID input accepts native Paste');
 await page.getByRole('button',{name:'Memory',exact:true}).click();
 const memory=page.getByPlaceholder('Something you want Jarvis to remember…');
 await chooseContext(memory,'paste');await expect(memory).toHaveValue(fixture);
 results.push('Memory textarea accepts native Paste without saving');
 await page.getByRole('button',{name:'Conversation',exact:true}).click();
 const message=page.getByRole('textbox',{name:'Message Jarvis'});
 await message.click();await message.press('Control+V');await expect(message).toHaveValue(fixture);
 await message.press('Control+A');await message.press('Control+C');
 assert(await app.evaluate(async({clipboard},fixture)=>(await clipboard.readText())===fixture,fixture));
 await chooseContext(message,'cut');await expect(message).toHaveValue('');
 await message.press('Control+Z');await expect(message).toHaveValue(fixture);
 await chooseContext(message,'selectAll');await chooseContext(message,'copy');
 assert(await app.evaluate(async({clipboard},fixture)=>(await clipboard.readText())===fixture,fixture));
 await message.fill('');results.push('Conversation supports keyboard Copy/Paste/Undo and native Cut/Copy/Select All');
 if(process.env.JARVIS_CLIPBOARD_UI==='1'){
  await app.evaluate(({Menu})=>{Menu.prototype.popup=globalThis.__editTest.popup;});
  await page.getByRole('button',{name:'Connections',exact:true}).click();
  const key=page.getByLabel('Claude API key',{exact:true});await key.fill('');
  await key.click({button:'right'});
  console.log('READY: native context menu is open on an empty dummy-test key field; choose Paste.');
  await expect.poll(async()=>(await key.inputValue())===fixture,{timeout:120000}).toBe(true);
  await key.fill('');results.push('Actual Windows right-click menu Paste clicked and inserted dummy text into masked API-key field');
 }
 const status=await page.evaluate(()=>window.jarvis.command({type:'snapshot'}));
 assert(status.ok);assert.equal(status.data.micStatus,'off');assert.equal(status.data.messages.length,0);
 assert(Object.values(status.data.credentials).every(v=>v==='missing'));
 results.push('No credentials saved, no message sent, microphone remains off');
 await mkdir('test-results',{recursive:true});
 await writeFile(`test-results/clipboard-${profile.packaged?'packaged':'source'}.json`,JSON.stringify({date:new Date().toISOString(),...profile,results},null,2));
 console.log(JSON.stringify({version:profile.version,packaged:profile.packaged,passed:results.length,results},null,2));
}finally{
 try{await app.evaluate(async({clipboard,Menu})=>{
  const test=globalThis.__editTest;if(!test)return;
  // Do not overwrite a new clipboard value copied by the user during the check.
  if(test.owned.has(await clipboard.readText()))await clipboard.write(test.original);
  Menu.prototype.popup=test.popup;delete globalThis.__editTest;
 });}finally{await app.close();}
}
