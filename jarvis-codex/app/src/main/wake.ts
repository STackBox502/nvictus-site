import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {AppError} from '../core';
export class WakeEngine{
 available=false;reason='Local Hey Jarvis runtime is not installed. See wake/README.md. Click-to-talk remains available.';private child?:ChildProcessWithoutNullStreams;private root='';
 constructor(private helper:string,roots:string[]){this.root=roots.find(root=>existsSync(path.join(root,'.venv','Scripts','python.exe'))&&existsSync(path.join(root,'models','hey_jarvis_v0.1.onnx')))||'';this.available=!!this.root;if(this.available)this.reason='Local runtime found; live false-activation and speaker tests are not yet verified.';}
 async start(wake:()=>void,error:(e:unknown)=>void,threshold:number){
  this.stop();if(!this.available)throw new AppError('WAKE_UNAVAILABLE',this.reason);
  const child=spawn(path.join(this.root,'.venv','Scripts','python.exe'),['-u',this.helper,path.join(this.root,'models'),String(threshold)],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});this.child=child;
  await new Promise<void>((resolve,reject)=>{let ready=false,buffer='';const timer=setTimeout(()=>{reject(new AppError('WAKE_TIMEOUT','Local wake engine did not start.'));this.stop();},45000);
   child.stdout.on('data',b=>{buffer+=b.toString();if(buffer.length>4096){error(new AppError('WAKE_PROTOCOL','Invalid local engine response.'));this.stop();return;}let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line==='READY'){ready=true;clearTimeout(timer);resolve();}else if(line==='WAKE')wake();else if(line==='ERROR'){const e=new AppError('WAKE_ENGINE','Wake runtime failed. Check pinned dependencies and ONNX artifacts.');if(!ready)reject(e);else error(e);this.stop();}}});
   child.stdin.on('error',()=>{if(this.child===child)error(new AppError('WAKE_PIPE','Local wake input closed.'));});
   child.stderr.on('data',()=>{/* Never relay subprocess content to UI/logs. */});
   child.on('error',()=>{clearTimeout(timer);reject(new AppError('WAKE_START','Could not launch the configured local Python runtime.'));});
   child.on('exit',()=>{clearTimeout(timer);if(this.child!==child)return;this.child=undefined;const e=new AppError('WAKE_EXIT','Local keyword engine stopped. Microphone must be reactivated.');if(!ready)reject(e);else error(e);});
  });
 }
 feed(pcm:Buffer){if(!this.child)return;if(this.child.stdin.writableLength>64000){this.stop();throw new AppError('WAKE_BACKPRESSURE','Local wake processing is too slow.');}this.child.stdin.write(pcm);}
 stop(){const child=this.child;this.child=undefined;if(child){child.stdin.end();child.kill();}}
}
