import {AppError} from '../core';
import type {Event} from '../shared';
import {pcmDb} from '../speech-detector';
// At most 10 x 100 ms of PCM scheduled ahead. Acks come from source.onended.
export class AudioOutput{
 private seq=0;private pending=new Map<number,{resolve:()=>void;reject:(e:unknown)=>void;promise:Promise<void>}>();private gen=0;private first=false;private levels=new Map<number,{db:number;ms:number}>();
 constructor(private send:(e:Event)=>void,private started:()=>void,private played?:(db:number,ms:number)=>void){}
 begin(generation:number){this.cancel();this.gen=generation;this.first=false;}
 acknowledge(generation:number,sequence:number,started=false){if(generation!==this.gen)return;if(started){const level=this.levels.get(sequence);if(level)this.played?.(level.db,level.ms);if(!this.first){this.first=true;this.started();}return;}this.levels.delete(sequence);const item=this.pending.get(sequence);if(item){this.pending.delete(sequence);item.resolve();}}
 async write(pcm:Uint8Array,generation:number,signal:AbortSignal){signal.throwIfAborted();if(generation!==this.gen)throw new AppError('CANCELLED','Stale audio rejected.');if(this.pending.size>=10)await this.waitOne(signal);signal.throwIfAborted();if(generation!==this.gen)throw new AppError('CANCELLED','Stale audio rejected.');const sequence=++this.seq;this.levels.set(sequence,{db:pcmDb(pcm),ms:pcm.byteLength/2/24000*1000});if(this.levels.size>64)this.levels.delete(this.levels.keys().next().value!);let resolve!:()=>void,reject!:(e:unknown)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});this.pending.set(sequence,{resolve,reject,promise});this.send({type:'audio',generation,sequence,pcm:new Uint8Array(pcm)});}
 private async waitOne(signal:AbortSignal){if(!this.pending.size)return;await this.bounded(Promise.race([...this.pending.values()].map(x=>x.promise)),signal);}
 private async bounded(p:Promise<unknown>,signal:AbortSignal){let timer:ReturnType<typeof setTimeout>|undefined;let onAbort:()=>void=()=>{};try{await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError('PLAYBACK_TIMEOUT','Audio playback stalled. Select an output device and retry.')),6000);onAbort=()=>reject(new DOMException('Aborted','AbortError'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();})]);}finally{clearTimeout(timer);signal.removeEventListener('abort',onAbort);}}
 async drain(signal:AbortSignal){await this.bounded(Promise.all([...this.pending.values()].map(x=>x.promise)),signal);}
 cancel(){for(const item of this.pending.values())item.reject(new DOMException('Aborted','AbortError'));this.pending.clear();this.levels.clear();this.gen=-1;}
 get queued(){return this.pending.size;}
}
