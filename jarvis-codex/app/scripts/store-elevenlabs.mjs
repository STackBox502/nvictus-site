import {app,safeStorage} from 'electron';
import {mkdir,readFile,writeFile,rename,copyFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.join(app.getPath('appData'),'Jarvis Codex');
app.setPath('userData',root);app.disableHardwareAcceleration();
async function store(){
 await app.whenReady();
 const key=process.env.ELEVENLABS_API_KEY;
 if(!key||key.length<8||key.length>512||!await safeStorage.isAsyncEncryptionAvailable())throw new Error('KEY_OR_ENCRYPTION_UNAVAILABLE');
 const folder=path.join(root,'credentials'),file=path.join(folder,'elevenlabs.vault');
 await mkdir(folder,{recursive:true});
 try{await copyFile(file,file+'.before-onboarding',1);}catch(e){if(!['ENOENT','EEXIST'].includes(e.code))throw e;}
 const encrypted=await safeStorage.encryptStringAsync(key);
 await writeFile(file+'.tmp',encrypted,{mode:0o600});await rename(file+'.tmp',file);
 const verified=(await safeStorage.decryptStringAsync(await readFile(file))).result===key;
 if(!verified)throw new Error('VERIFY_FAILED');
 console.log(JSON.stringify({storedForJarvis:true,encrypted:true,verified:true}));
}
store().catch(()=>{process.exitCode=1;console.error('Encrypted key transfer failed. No key was logged.');}).finally(()=>app.exit(process.exitCode||0));
