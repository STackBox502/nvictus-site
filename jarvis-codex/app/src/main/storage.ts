import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {SettingsSchema,defaults,type Settings,type Memory,type Message,type Credential} from '../shared';
import {AppError} from '../core';
export async function atomicJson(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);}
const MemorySchema=z.object({id:z.string().max(100),text:z.string().max(2000),created:z.number(),updated:z.number()}).strict();
const MessageSchema=z.object({id:z.string().max(100),role:z.enum(['user','assistant']),text:z.string().max(32000),created:z.number(),status:z.enum(['complete','streaming','interrupted','failed']),heardText:z.string().max(32000).optional(),provider:z.enum(['anthropic','openai']).optional(),model:z.string().max(120).optional()}).strict();
export class Repository{
 settings:Settings=defaults();memories:Memory[]=[];history:Message[]=[];warning='';private pending=Promise.resolve();
 constructor(public root:string){}
 async load(){
  await mkdir(this.root,{recursive:true});
  for(const name of ['settings','memories','history'] as const){try{const raw=await readFile(path.join(this.root,`${name}.json`),'utf8');if(raw.length>4_000_000)throw Error();const data=JSON.parse(raw);if(name==='settings')this.settings=SettingsSchema.parse(data);else if(name==='memories')this.memories=z.array(MemorySchema).max(100).parse(data);else if(this.settings.persistentHistory)this.history=z.array(MessageSchema).max(200).parse(data).map(m=>m.status==='streaming'?{...m,status:'interrupted'}:m);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.warning=`Could not load ${name}; using a safe empty/default value. Original file is preserved until you save.`;}}
 }
 private serialize(fn:()=>Promise<void>){const task=this.pending.then(fn);this.pending=task.catch(()=>{});return task;}
 saveSettings(settings:Settings){return this.serialize(async()=>{const next=SettingsSchema.parse(settings);await atomicJson(path.join(this.root,'settings.json'),next);this.settings=next;if(!next.persistentHistory)await unlink(path.join(this.root,'history.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});});}
 saveMemory(text:string,id?:string){return this.serialize(async()=>{const now=Date.now();const record:Memory={id:id??randomUUID(),text,created:now,updated:now};const list=this.memories.map(m=>m.id===id?{...m,text,updated:now}:m);if(!id)list.push(record);else if(!list.some(m=>m.id===id))throw new AppError('MEMORY_MISSING','Memory no longer exists.');z.array(MemorySchema).max(100).parse(list);await atomicJson(path.join(this.root,'memories.json'),list);this.memories=list;});}
 deleteMemory(id:string){return this.serialize(async()=>{const next=this.memories.filter(m=>m.id!==id);await atomicJson(path.join(this.root,'memories.json'),next);this.memories=next;});}
 saveHistory(messages:Message[]){const snapshot=structuredClone(messages.slice(-200));return this.serialize(async()=>{if(this.settings.persistentHistory)await atomicJson(path.join(this.root,'history.json'),snapshot);});}
 clearHistory(){return this.serialize(async()=>{await unlink(path.join(this.root,'history.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});this.history=[];});}
 flush(){return this.pending;}
}
export type Cipher={available:()=>Promise<boolean>;encrypt:(s:string)=>Promise<Buffer>;decrypt:(b:Buffer)=>Promise<string>};
export class Vault{
 private keys:Partial<Record<Credential,string>>={};private statuses:Record<Credential,'missing'|'session'|'encrypted'|'locked'>={anthropic:'missing',openai:'missing',elevenlabs:'missing'};
 constructor(private root:string,private cipher:Cipher){}
 async load(){for(const p of ['anthropic','openai','elevenlabs'] as const){try{const encrypted=await readFile(path.join(this.root,`${p}.vault`));if(!await this.cipher.available()){this.statuses[p]='locked';continue;}this.keys[p]=await this.cipher.decrypt(encrypted);this.statuses[p]='encrypted';}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')this.statuses[p]='locked';}}}
 get(p:Credential){const k=this.keys[p];if(!k)throw new AppError('KEY_REQUIRED',`Configure ${p} in Connections first.`);return k;}
 has(p:Credential){return !!this.keys[p];}
 status(){return {...this.statuses};}
 async set(p:Credential,value:string,persist:boolean){
  if(persist){if(!await this.cipher.available())throw new AppError('ENCRYPTION_UNAVAILABLE','Windows credential protection is unavailable. Choose session-only storage.');const b=await this.cipher.encrypt(value);await mkdir(this.root,{recursive:true});const f=path.join(this.root,`${p}.vault`);await writeFile(`${f}.tmp`,b,{mode:0o600});await rename(`${f}.tmp`,f);}else await unlink(path.join(this.root,`${p}.vault`)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  this.keys[p]=value;this.statuses[p]=persist?'encrypted':'session';
 }
 async delete(p:Credential){await unlink(path.join(this.root,`${p}.vault`)).catch(e=>{if(e.code!=='ENOENT')throw e;});delete this.keys[p];this.statuses[p]='missing';}
 clearRam(){this.keys={};}
}
