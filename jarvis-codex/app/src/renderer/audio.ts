import type {Event,Snapshot} from '../shared';
const api=window.jarvis;
export class AudioEngine{
 private input?:AudioContext;private stream?:MediaStream;private worklet?:AudioWorkletNode;private output?:AudioContext;private gain?:GainNode;private analyser?:AnalyserNode;private sources=new Set<AudioBufferSourceNode>();private timers=new Set<ReturnType<typeof setTimeout>>();private outTime=0;private captureGen=-1;private outputGen=-1;private sequence=0;private inFlight=0;private silenceAt=0;private heard=false;private captureAt=0;private mode='command';private stopped=false;private cancelledBefore=0;private outputMeter?:ReturnType<typeof setInterval>;
 private playQueue:Promise<void>=Promise.resolve();private previousState='';
 constructor(private snapshot:()=>Snapshot|undefined){}
 async event(event:Event){
  if(event.type==='snapshot'){if(this.previousState==='armed'&&event.value.state==='listening'){this.heard=false;this.silenceAt=0;this.captureAt=performance.now();}this.previousState=event.value.state;}
  if(event.type==='cancel'){this.cancelledBefore=event.generation;this.stopOutput();this.outputGen=event.generation;}
  if(event.type==='capture'){if(event.action==='stop')this.stopInput();else await this.startInput(event.generation,event.mode??'command');}
  if(event.type==='audio'){this.playQueue=this.playQueue.then(()=>this.play(event));await this.playQueue;}
 }
 private async startInput(generation:number,mode:string){
  this.stopInput();this.captureGen=generation;this.mode=mode;this.sequence=0;this.heard=false;this.silenceAt=0;this.captureAt=performance.now();this.stopped=false;const settings=this.snapshot()!.settings;
  try{
   const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:settings.inputDevice?{exact:settings.inputDevice}:undefined,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
   if(this.captureGen!==generation){stream.getTracks().forEach(t=>t.stop());return;}
   this.stream=stream;const context=new AudioContext();this.input=context;await context.audioWorklet.addModule('jarvis://app/pcm-worklet.js');if(this.captureGen!==generation){await context.close().catch(()=>{});return;}
   const source=context.createMediaStreamSource(stream);this.worklet=new AudioWorkletNode(context,'pcm-capture');const silence=context.createGain();silence.gain.value=0;source.connect(this.worklet);this.worklet.connect(silence).connect(context.destination);
   stream.getAudioTracks()[0].onended=()=>{if(this.captureGen===generation){this.stopInput();void api.command({type:'mic-status',generation,status:'ended'});}};
   this.worklet.port.onmessage=e=>{if(this.captureGen!==generation||this.stopped)return;const pcm=e.data as ArrayBuffer;const data=new Int16Array(pcm);let sq=0;for(const value of data)sq+=(value/32768)**2;const rms=Math.sqrt(sq/data.length);void api.command({type:'level',generation,input:Math.min(1,rms*4)});
    if(this.inFlight>12){this.stopInput();void api.command({type:'mic-status',generation,status:'unavailable'});return;}
    this.inFlight++;void api.pcm(generation,this.sequence++,pcm).finally(()=>{if(this.captureGen===generation)this.inFlight--;});
    const state=this.snapshot()?.state;
    if(state==='listening'&&this.mode!=='test'&&this.mode!=='conversation'){
     if(rms>.018){this.heard=true;this.silenceAt=performance.now();}
     if(this.heard&&this.silenceAt&&performance.now()-this.silenceAt>settings.silenceMs){this.stopped=true;void api.command({type:'control',action:'commit'});}
     if(!this.heard&&performance.now()-this.captureAt>12000){this.stopped=true;void api.command({type:'control',action:'stop'});}
    }
   };
   await context.resume();if(this.captureGen!==generation)return;await api.command({type:'mic-status',generation,status:'capturing'});
  }catch(e){if(this.captureGen!==generation)return;this.stopInput();await api.command({type:'mic-status',generation,status:e instanceof DOMException&&e.name==='NotAllowedError'?'denied':'unavailable'});}
 }
 stopInput(){this.captureGen=-1;this.stopped=true;this.worklet?.port.close();this.worklet?.disconnect();this.worklet=undefined;this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=undefined;const context=this.input;this.input=undefined;if(context)void context.close().catch(()=>{});this.inFlight=0;}
 async ensureOutput(){if(this.output&&this.output.state!=='closed')return;this.output=new AudioContext({sampleRate:24000});this.gain=this.output.createGain();this.analyser=this.output.createAnalyser();this.analyser.fftSize=256;this.gain.connect(this.analyser).connect(this.output.destination);await this.applyOutputSettings();const buffer=new Float32Array(256);this.outputMeter=setInterval(()=>{if(!this.sources.size)return;this.analyser?.getFloatTimeDomainData(buffer);let sum=0;for(const v of buffer)sum+=v*v;void api.command({type:'level',generation:this.outputGen,output:Math.min(1,Math.sqrt(sum/buffer.length)*4)});},100);}
 async applyOutputSettings(){const s=this.snapshot()?.settings;if(!s||!this.output)return;if(this.gain)this.gain.gain.value=s.volume;const output=this.output as AudioContext&{setSinkId?:(id:string)=>Promise<void>};if(output.setSinkId)await output.setSinkId(s.outputDevice||'');else if(s.outputDevice)throw Error('Output selection unavailable. Use Windows system output.');}
 private async play(e:Extract<Event,{type:'audio'}>){
  if(e.generation<this.cancelledBefore)return;
  try{
   await this.ensureOutput();if(e.generation<this.cancelledBefore)return;const context=this.output!;await context.resume();if(e.generation<this.cancelledBefore)return;
   if(this.outputGen!==e.generation){this.stopOutput();this.outputGen=e.generation;}
   const bytes=new Uint8Array(e.pcm),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);const buffer=context.createBuffer(1,bytes.length/2,24000);const channel=buffer.getChannelData(0);for(let i=0;i<channel.length;i++)channel[i]=view.getInt16(i*2,true)/32768;
   const source=context.createBufferSource();source.buffer=buffer;source.connect(this.gain!);this.sources.add(source);const start=Math.max(context.currentTime+.025,this.outTime);this.outTime=start+buffer.duration;
   const timer=setTimeout(()=>{this.timers.delete(timer);if(this.outputGen===e.generation&&this.sources.has(source))void api.command({type:'audio-ack',generation:e.generation,sequence:e.sequence,started:true});},Math.max(0,(start-context.currentTime)*1000));this.timers.add(timer);
   source.onended=()=>{source.disconnect();this.sources.delete(source);if(this.outputGen===e.generation)void api.command({type:'audio-ack',generation:e.generation,sequence:e.sequence});};source.start(start);
  }catch{this.stopOutput();void api.command({type:'control',action:'stop'});}
 }
 stopOutput(){for(const timer of this.timers)clearTimeout(timer);this.timers.clear();for(const source of this.sources){source.onended=null;try{source.stop();source.disconnect();}catch{/* Already ended. */}}this.sources.clear();this.outTime=0;}
 dispose(){this.stopInput();this.stopOutput();clearInterval(this.outputMeter);void this.output?.close().catch(()=>{});}
}
