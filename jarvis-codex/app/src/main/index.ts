import {app,BrowserWindow,ipcMain,Menu,Tray,nativeImage,screen,globalShortcut,dialog,safeStorage,session,protocol,powerMonitor} from 'electron';
import path from 'node:path';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {CommandSchema,defaults,type Event,type Result} from '../shared';
import {AppError,clampBounds,safeError} from '../core';
import {Repository,Vault,atomicJson} from './storage';
import {Providers,type RealtimeStt} from './providers';
import {Controller} from './controller';
import {WakeEngine} from './wake';
import {installEditingMenu,installTextContextMenu} from './editing';

app.setName('Jarvis Codex');
const testMode=!app.isPackaged&&process.argv.includes('--test-mode');
const dataRoot=testMode?path.join(app.getAppPath(),'test-results',`profile-${process.pid}`):path.join(app.getPath('appData'),'Jarvis Codex');
app.setPath('userData',dataRoot);app.setAppUserModelId('com.nvictus.jarvis.codex');
protocol.registerSchemesAsPrivileged([{scheme:'jarvis',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
let chat:BrowserWindow,overlay:BrowserWindow,tray:Tray,controller:Controller,repo:Repository,vault:Vault,providers:Providers,quitting=false;
let positionTimer:ReturnType<typeof setTimeout>|undefined;let savedPosition:{x:number;y:number}|undefined;
let assetDecode:{id:string;resolve:(b:Buffer)=>void;reject:(e:unknown)=>void}|undefined;
async function decodeWebp(bytes:Buffer){
 if(assetDecode)throw new AppError('ASSET_BUSY','Another character import is still decoding.');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await new Promise<Buffer>((resolve,reject)=>{const id=randomUUID();assetDecode={id,resolve,reject};timer=setTimeout(()=>reject(new AppError('ASSET_TIMEOUT','Image decode timed out.')),15000);chat.webContents.send('jarvis:event',{type:'decode-asset',id,bytes:new Uint8Array(bytes)} satisfies Event);});}finally{clearTimeout(timer);assetDecode=undefined;}
}
const trusted=(url:string)=>{try{const u=new URL(url);return u.protocol==='jarvis:'&&u.host==='app'&&u.pathname==='/index.html';}catch{return false;}};
function sendAll(e:Event){for(const win of [chat,overlay])if(win&&!win.isDestroyed())win.webContents.send('jarvis:event',e);if(tray&&controller)tray.setToolTip(`Jarvis Codex — ${controller.micStatus==='capturing'?controller.conversation?'Conversation — microphone live':controller.state==='armed'?'Local wake listening':'Microphone active':'Microphone off'}`);}
function sendAudio(e:Event){if(chat&&!chat.isDestroyed())chat.webContents.send('jarvis:event',e);}
function showChat(tab?:string){chat.show();chat.focus();if(tab)chat.webContents.send('jarvis:event',{type:'tab',tab});}
function guardWindow(win:BrowserWindow){win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.webContents.on('will-attach-webview',e=>e.preventDefault());win.webContents.on('render-process-gone',()=>controller?.stop('Window stopped. Capture and speech canceled. Restart Jarvis.'));}
function placement(reset=false){if(!overlay)return;const s=repo.settings;const displays=screen.getAllDisplays();const selected=displays.find(d=>String(d.id)===s.displayId)??screen.getPrimaryDisplay();const width=s.overlaySize+48,height=s.overlaySize+120;const pos=!reset?savedPosition:undefined;const area=pos?screen.getDisplayNearestPoint(pos).workArea:selected.workArea;const b=clampBounds({width,height,x:pos?.x??(s.dock==='right'?area.x+area.width-width-16:area.x+16),y:pos?.y??Math.round(area.y+(area.height-height)*.56)},area);overlay.setBounds(b);overlay.setAlwaysOnTop(s.alwaysOnTop,'floating');overlay.setOpacity(s.opacity);if(s.visibility==='hidden')overlay.hide();else overlay.showInactive();controller.displays=displays.map(d=>({id:String(d.id),label:`${d.label||'Display '+d.id} • ${d.size.width} × ${d.size.height}`}));controller.emit();}
function registerKeys(){globalShortcut.unregisterAll();const notes:string[]=[];
 const reg=(key:string,action:()=>void)=>{try{if(!globalShortcut.register(key,action))notes.push(`${key} is unavailable. Use tray or click controls.`);}catch{notes.push(`${key} is invalid. Use tray controls.`);}};
 reg(repo.settings.talkHotkey,()=>{try{if(controller.conversation)controller.manualInterrupt();else if(controller.state==='listening')controller.commit();else controller.startTalk();}catch(e){controller.notice=safeError(e);controller.emit();showChat();}});
 reg(repo.settings.stopHotkey,()=>controller.stop());controller.hotkeys=notes.join(' ')||`Talk: ${repo.settings.talkHotkey} · Stop: ${repo.settings.stopHotkey}`;
}
function confirm(title:string,message:string){return dialog.showMessageBox(chat,{type:'question',title,message,buttons:['Cancel','Confirm'],defaultId:0,cancelId:0,noLink:true}).then(r=>r.response===1);}
async function exportData(kind:'chat-json'|'chat-markdown'|'memory'|'diagnostics'){
 const markdown=kind==='chat-markdown';const chosen=await dialog.showSaveDialog(chat,{title:'Export local Jarvis data',defaultPath:`Jarvis-Codex-${kind}.${markdown?'md':'json'}`,filters:[{name:markdown?'Markdown':'JSON',extensions:[markdown?'md':'json']}]});if(chosen.canceled||!chosen.filePath)return;
 const value=kind==='diagnostics'?{app:'Jarvis Codex',version:app.getVersion(),versions:process.versions,platform:process.platform,architecture:process.arch,provider:repo.settings.provider,model:repo.settings.provider==='anthropic'?repo.settings.anthropicModel:repo.settings.openaiModel,ttsModel:repo.settings.ttsModel,credentials:vault.status(),state:controller.state,micStatus:controller.micStatus,usage:controller.usage,hotkeys:controller.hotkeys,wakeAvailable:controller.wake.available,vision:'not implemented; awaiting real voice baseline'}:kind==='memory'?repo.memories:controller.messages;
 const text=markdown?controller.messages.map(m=>`## ${m.role==='user'?'You':'Jarvis'} (${m.status})\n\n${m.text}\n`).join('\n'):JSON.stringify(value,null,2);await writeFile(chosen.filePath,text,'utf8');controller.notice='Export saved to your selected file.';controller.emit();
}
async function importAsset(){const result=await dialog.showOpenDialog(chat,{title:'Import transparent character',properties:['openFile'],filters:[{name:'Transparent image',extensions:['png','webp']}]});if(result.canceled)return;const file=result.filePaths[0];const info=await stat(file);if(info.size>8*1024*1024)throw new AppError('ASSET_SIZE','Choose an image smaller than 8 MB.');const bytes=await readFile(file);const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!png&&!webp)throw new AppError('ASSET_FORMAT','The file signature is not PNG or WebP.');const image=nativeImage.createFromBuffer(webp?await decodeWebp(bytes):bytes),size=image.getSize();if(image.isEmpty()||size.width<64||size.height<64||size.width>4096||size.height>4096)throw new AppError('ASSET_DIMENSIONS','Choose a decodable image from 64 to 4096 pixels per side.');const bitmap=image.toBitmap();let alpha=false;for(let i=3;i<bitmap.length;i+=4)if(bitmap[i]<255){alpha=true;break;}if(!alpha)throw new AppError('ASSET_ALPHA','Use a transparent PNG/WebP so the companion has no opaque rectangle.');await mkdir(dataRoot,{recursive:true});await writeFile(path.join(dataRoot,'character.png'),image.toPNG());controller.asset=`jarvis://app/current-character?rev=${Date.now()}`;controller.notice='Character imported into Jarvis Codex app data.';controller.emit();}
async function localControl(action:string){
 switch(action){
  case 'talk':if(controller.conversation)controller.manualInterrupt();else controller.startTalk();break;case 'converse':controller.startConversation();break;case 'end-conversation':controller.endConversation();break;case 'mic-test':controller.startMicTest();break;case 'commit':controller.commit();break;case 'stop':case 'disarm':controller.stop('All audio capture and speech stopped.');break;
  case 'mute':controller.mute(true);break;case 'unmute':controller.mute(false);break;case 'show':overlay.showInactive();showChat();break;
  case 'hide':overlay.hide();controller.notice='Character hidden. Microphone controls remain in chat and tray.';controller.emit();break;
  case 'settings':showChat('Connections');break;case 'quit':app.quit();break;case 'new':if(await confirm('New conversation','Delete current conversation and its saved local history? Saved memories remain.'))await controller.newConversation();break;
  case 'arm':await controller.arm();break;
 }
}
const runBackground=(task:Promise<unknown>)=>{void task.catch(e=>{controller.notice=safeError(e);controller.emit();});};
async function handle(event:Electron.IpcMainInvokeEvent,raw:unknown):Promise<Result>{
 try{
  const isChat=event.sender===chat?.webContents,isOverlay=event.sender===overlay?.webContents;
  if((!isChat&&!isOverlay)||event.senderFrame!==event.sender.mainFrame||!trusted(event.senderFrame.url))throw new AppError('IPC_DENIED','Untrusted sender.');
  const c=CommandSchema.parse(raw);
  const overlayAllowed=['snapshot','control','hit'];if(isOverlay&&!overlayAllowed.includes(c.type))throw new AppError('IPC_DENIED','Action is restricted to chat.');
  if(c.type==='snapshot')return {ok:true,data:controller.snapshot()};
  if(c.type==='send'){
   const command=c.text.trim().toLowerCase().replace(/[.!?]+$/,'');
   if(command==='hide character')await localControl('hide');else if(command==='show character')await localControl('show');else if(command==='switch provider'||command==='change voice'){showChat('Connections');controller.notice='Choose and confirm the provider or voice in Connections.';controller.emit();}else runBackground(controller.send(c.id,c.text));
  }
  else if(c.type==='control')await localControl(c.action);
  else if(c.type==='settings'){const previous=repo.settings;await controller.updateSettings(c.value,c.acknowledgeProvider);registerKeys();if(!testMode&&previous.launchAtLogin!==c.value.launchAtLogin)app.setLoginItemSettings({openAtLogin:c.value.launchAtLogin,enabled:c.value.launchAtLogin});placement(previous.dock!==c.value.dock||previous.displayId!==c.value.displayId);}
  else if(c.type==='secret'){controller.stop('Credential updated. Refresh its account catalog.');await vault.set(c.provider,c.value,c.persist);await controller.credentialsChanged(c.provider);}
  else if(c.type==='delete-secret'){if(await confirm('Remove credential',`Remove this app’s ${c.provider} credential? This does not revoke it at the provider.`)){controller.stop();await vault.delete(c.provider);await controller.credentialsChanged(c.provider);}}
  else if(c.type==='catalog'){if(controller.snapshot().preview)throw new AppError('PREVIEW_ONLY','Exit preview before connecting.');try{const catalog=await providers.catalog(c.provider);controller.connections[c.provider]='Catalog reached; generation not yet verified';controller.emit();return {ok:true,data:catalog};}catch(e){controller.connections[c.provider]=safeError(e);controller.emit();throw e;}}
  else if(c.type==='voice-preview')runBackground(controller.previewVoice());
  else if(c.type==='memory-save'){await repo.saveMemory(c.text,c.id);controller.notice='Memory saved locally.';controller.emit();}
  else if(c.type==='memory-delete'){if(await confirm('Forget memory','Permanently delete this saved memory from Jarvis Codex?')){await repo.deleteMemory(c.id);controller.notice='Memory deleted locally.';controller.emit();}}
  else if(c.type==='export')await exportData(c.kind);
  else if(c.type==='import-asset')await importAsset();
  else if(c.type==='asset-decoded'){if(!assetDecode||c.id!==assetDecode.id)throw new AppError('ASSET_TRANSACTION','No matching selected image import.');if(c.png)assetDecode.resolve(Buffer.from(c.png,'base64'));else assetDecode.reject(new AppError('ASSET_DECODE','WebP image could not be decoded within size limits.'));}
  else if(c.type==='reset-settings'){if(await confirm('Reset settings','Reset non-secret settings? Credentials and saved memories remain. Persisted chat history will be deleted because the default is session-only.')){await controller.updateSettings(defaults(),true);placement(true);registerKeys();if(!testMode)app.setLoginItemSettings({openAtLogin:false});}}
  else if(c.type==='preview')controller.setPreview(c.state);
  else if(c.type==='hit'&&isOverlay)overlay.setIgnoreMouseEvents(!c.interactive,{forward:true});
  else if(c.type==='audio-ack')controller.ack(c.generation,c.sequence,c.started);
  else if(c.type==='audio-ready')controller.micReady(c.generation);
  else if(c.type==='mic-status'&&controller.validCapture(c.generation)){if(c.status==='capturing')controller.micReady(c.generation);else if(['denied','unavailable','ended'].includes(c.status))controller.failCapture(c.status==='denied'?'Microphone permission denied. Enable it in Windows Settings, then activate Talk.':'Selected input is unavailable or disconnected. Choose an input in Audio; no replacement was selected.');}
  else if(c.type==='level')controller.level(c.generation,c.input,c.output);
  return {ok:true};
 }catch(e){return {ok:false,error:e instanceof z.ZodError?'INVALID_INPUT: Check field values and limits.':safeError(e)};}
}
async function boot(){
 await app.whenReady();
 installEditingMenu();
 repo=new Repository(dataRoot);await repo.load();vault=new Vault(path.join(dataRoot,'credentials'),{available:()=>safeStorage.isAsyncEncryptionAvailable(),encrypt:s=>safeStorage.encryptStringAsync(s),decrypt:async b=>(await safeStorage.decryptStringAsync(b)).result});await vault.load();providers=new Providers(p=>vault.get(p));
 const wakeBase=app.isPackaged?path.join(process.resourcesPath,'wake'):path.join(app.getAppPath(),'wake');
 controller=new Controller(repo,vault,providers,sendAll,sendAudio,new WakeEngine(path.join(wakeBase,'helper.py'),[path.join(dataRoot,'wake'),wakeBase]));controller.preview=process.argv.includes('--visual-preview');
 // Unpackaged --test-mode only: speech sessions are simulated offline so automated smoke tests never contact ElevenLabs.
 if(testMode)controller.createStt=(_key,callbacks)=>({start(){},feed(){},commit(){setTimeout(()=>callbacks.final(''),10);},close(){callbacks.seconds(0);}}) as unknown as RealtimeStt;
 if(repo.warning)controller.notice=repo.warning;
 const rendererRoot=path.join(__dirname,'renderer');
 protocol.handle('jarvis',async request=>{try{const u=new URL(request.url);if(u.host!=='app'||request.method!=='GET')return new Response('Denied',{status:403});let file:string;if(u.pathname==='/current-character')file=existsSync(path.join(dataRoot,'character.png'))?path.join(dataRoot,'character.png'):path.join(rendererRoot,'jarvis-character.png');else{file=path.resolve(rendererRoot,'.'+decodeURIComponent(u.pathname));if(!file.startsWith(rendererRoot+path.sep))return new Response('Denied',{status:403});}const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.webp':'image/webp'};return new Response(new Uint8Array(await readFile(file)),{headers:{'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff'}});}catch{return new Response('Unavailable',{status:404});}});
 const permissionSession=session.defaultSession;
 permissionSession.setPermissionCheckHandler((web,permission,origin,details)=>{if(web!==chat?.webContents||origin!=='jarvis://app'||!trusted(web.getURL())||details.isMainFrame===false)return false;if(permission==='speaker-selection')return true;return permission==='media'&&details.mediaType==='audio'&&controller.micStatus==='requesting'&&!controller.snapshot().preview;});
 permissionSession.setPermissionRequestHandler((web,permission,callback,details)=>{const types='mediaTypes'in details?(details.mediaTypes??[]):[];callback(web===chat?.webContents&&trusted(web.getURL())&&(!('isMainFrame'in details)||details.isMainFrame!==false)&&((permission==='media'&&types.length===1&&types[0]==='audio'&&controller.micStatus==='requesting'&&!controller.snapshot().preview)||permission==='speaker-selection'));});
 permissionSession.setDisplayMediaRequestHandler((_request,callback)=>callback({}));
 permissionSession.webRequest.onBeforeRequest((details,callback)=>{const u=new URL(details.url);callback({cancel:!['jarvis:','devtools:','data:','blob:'].includes(u.protocol)});});
 chat=new BrowserWindow({title:'Jarvis Codex',width:1180,height:820,minWidth:860,minHeight:640,backgroundColor:'#101017',show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
 overlay=new BrowserWindow({title:'Jarvis Codex Companion',width:318,height:390,frame:false,transparent:true,resizable:false,skipTaskbar:true,focusable:false,show:false,alwaysOnTop:repo.settings.alwaysOnTop,hasShadow:false,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true}});
 guardWindow(chat);guardWindow(overlay);installTextContextMenu(chat);overlay.setIgnoreMouseEvents(true,{forward:true});
 chat.on('close',e=>{if(!quitting){e.preventDefault();chat.hide();}});overlay.on('close',e=>{if(!quitting){e.preventDefault();overlay.hide();}});
 overlay.on('moved',()=>{const b=overlay.getBounds();savedPosition={x:b.x,y:b.y};clearTimeout(positionTimer);positionTimer=setTimeout(()=>{void atomicJson(path.join(dataRoot,'overlay-position.json'),savedPosition).catch(()=>{});},500);});
 try{const p=JSON.parse(await readFile(path.join(dataRoot,'overlay-position.json'),'utf8'));savedPosition=z.object({x:z.number().int().min(-50000).max(50000),y:z.number().int().min(-50000).max(50000)}).parse(p);}catch{/* Position is optional. */}
 ipcMain.handle('jarvis:command',handle);
 let packetGen=-1,packetSeq=-1;
 ipcMain.handle('jarvis:pcm',(event,generation:unknown,sequence:unknown,pcm:unknown)=>{if(event.sender!==chat.webContents||event.senderFrame!==chat.webContents.mainFrame||!trusted(event.senderFrame.url)||!Number.isInteger(generation)||!Number.isInteger(sequence)||!(pcm instanceof ArrayBuffer)||pcm.byteLength!==2560)return false;const gen=generation as number,seq=sequence as number;if(!controller.validCapture(gen))return false;if(gen!==packetGen){packetGen=gen;packetSeq=-1;}if(seq!==packetSeq+1){controller.failCapture('Audio packets arrived out of order. Start again.');return false;}packetSeq=seq;try{return controller.feed(gen,seq,Buffer.from(pcm));}catch(e){controller.failCapture(safeError(e));return false;}});
 await Promise.all([chat.loadURL('jarvis://app/index.html?window=main'),overlay.loadURL('jarvis://app/index.html?window=overlay')]);
 const icon=nativeImage.createFromPath(path.join(rendererRoot,'jarvis-character.png')).resize({width:32,height:32});tray=new Tray(icon);tray.setToolTip('Jarvis Codex — Microphone off');
 const menu=()=>Menu.buildFromTemplate([{label:'Open chat / recover controls',click:()=>showChat()},{label:'Talk / interrupt',click:()=>runBackground(localControl('talk'))},{label:'Start conversation',click:()=>runBackground(localControl('converse'))},{label:'End conversation',click:()=>runBackground(localControl('end-conversation'))},{label:'Finish utterance',click:()=>controller.commit()},{label:'Stop all audio',click:()=>controller.stop()},{label:'Mute microphone',click:()=>controller.mute(true)},{label:'Unmute microphone',click:()=>controller.mute(false)},{type:'separator'},{label:'Show character',click:()=>overlay.showInactive()},{label:'Hide character',click:()=>overlay.hide()},{label:'Settings',click:()=>showChat('Connections')},{type:'separator'},{label:'Quit Jarvis Codex',click:()=>app.quit()}]);tray.setContextMenu(menu());tray.on('double-click',()=>showChat());overlay.webContents.on('context-menu',()=>menu().popup({window:overlay}));
 registerKeys();placement();chat.show();controller.emit();
 screen.on('display-added',()=>placement());screen.on('display-removed',()=>placement());screen.on('display-metrics-changed',()=>placement());
 const suspend=()=>{controller.stop('Microphone off after Windows lock/sleep/resume. Activate Talk to continue.');controller.refreshReady();controller.emit();};powerMonitor.on('suspend',suspend);powerMonitor.on('lock-screen',suspend);powerMonitor.on('resume',suspend);powerMonitor.on('unlock-screen',suspend);
 if(testMode){await mkdir(path.join(app.getAppPath(),'test-results'),{recursive:true});await writeFile(path.join(app.getAppPath(),'test-results','startup.json'),JSON.stringify({versions:process.versions,name:app.getName(),userData:app.getPath('userData'),permissions:'audio only; explicit activation',packaged:app.isPackaged}));}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{app.on('second-instance',()=>chat&&showChat());app.on('window-all-closed',()=>{if(quitting)app.quit();});app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;clearTimeout(positionTimer);globalShortcut.unregisterAll();void (controller?.shutdown()??Promise.resolve()).finally(()=>{tray?.destroy();app.quit();});});void boot().catch(error=>{if(testMode){console.error('TEST_STARTUP_FAILURE',error);app.quit();return;}dialog.showErrorBox('Jarvis Codex could not start','Startup failed. Check writable app data, installed runtime, and TEST_REPORT.md. No credentials or provider payloads are logged.');app.quit();});}
