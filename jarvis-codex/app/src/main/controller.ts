import {randomUUID} from 'node:crypto';
import {AppError,contextMessages,emptyUsage,safeError,Segmenter,systemPrompt,TurnGate} from '../core';
import type {Event,Message,Snapshot,Settings,State,Credential,Usage} from '../shared';
import {AudioOutput} from './audio-output';
import {Providers,RealtimeStt} from './providers';
import {Repository,Vault} from './storage';
import type {WakeEngine} from './wake';
export class Controller{
 gate=new TurnGate();state:State='unconfigured';messages:Message[];notice='Add a conversation provider in Connections to begin.';partial='';micStatus='off';micLevel=0;outputLevel=0;connections:Snapshot['connections']={};usage:Usage=emptyUsage();
 preview=false;previewState:State|null=null;asset='jarvis://app/current-character';hotkeys='';displays:Snapshot['displays']=[];
 private abort?:AbortController;private stt?:RealtimeStt;private audio:AudioOutput;private utteranceTimer?:ReturnType<typeof setTimeout>;private readyTimer?:ReturnType<typeof setTimeout>;private dirtyTimer?:ReturnType<typeof setTimeout>;private followTimer?:ReturnType<typeof setTimeout>;private current?:Message;private listeningGen=-1;private muted=false;private armed=false;private testingMic=false;private followingUp=false;private activeFollowUp=false;private lastInputAt=0;private speechEndedAt=0;private preRoll:Buffer[]=[];private wakeAt=0;
 constructor(public repo:Repository,public vault:Vault,private providers:Providers,private broadcast:(e:Event)=>void,private audioSend:(e:Event)=>void,public wake:WakeEngine){
  this.messages=structuredClone(repo.history);this.audio=new AudioOutput(audioSend,()=>{this.state='speaking';const timing=this.usage.timings.at(-1);if(timing&&!timing.firstPlayback)timing.firstPlayback=Date.now();this.emit();});this.refreshReady();
 }
 snapshot():Snapshot{return {settings:this.repo.settings,state:this.previewState??this.state,generation:this.gate.generation,messages:this.messages,memories:this.repo.memories,credentials:this.vault.status(),connections:this.connections,notice:this.notice,partial:this.partial,usage:this.usage,micLevel:this.micLevel,outputLevel:this.outputLevel,micStatus:this.micStatus,preview:this.preview||this.previewState!==null,asset:this.asset,hotkeys:this.hotkeys,wakeAvailable:this.wake.available,wakeReason:this.wake.reason,displays:this.displays};}
 emit(){this.broadcast({type:'snapshot',value:this.snapshot()});}
 private emitSoon(){if(!this.dirtyTimer)this.dirtyTimer=setTimeout(()=>{this.dirtyTimer=undefined;this.emit();},50);}
 refreshReady(){if(['unconfigured','idle','muted','interrupted','error'].includes(this.state)){const s=this.repo.settings;this.state=this.muted?'muted':this.vault.has(s.provider)&&!!this.model(s)?'idle':'unconfigured';}}
 private model(s:Settings){return s.provider==='anthropic'?s.anthropicModel:s.openaiModel;}
 private assertLive(){if(this.preview||this.previewState!==null)throw new AppError('PREVIEW_ONLY','Exit visual preview before using providers or microphone.');}
 private budget(){const s=this.repo.settings;if(this.usage.turns>=s.sessionTurnLimit)throw new AppError('SESSION_LIMIT','Session turn limit reached. Start a new conversation to reset counters.');}
 private requireVoice(){const s=this.repo.settings;this.vault.get(s.provider);this.vault.get('elevenlabs');if(!this.model(s)||!s.voiceId)throw new AppError('SETUP_REQUIRED','Choose a conversation model and ElevenLabs voice before talking.');if(this.usage.sttSeconds>=s.maxSttSeconds)throw new AppError('SESSION_LIMIT','Session listening limit reached.');}
 stop(reason='Stopped.',disarm=true){
  if(disarm)this.armed=false;this.testingMic=false;
  this.gate.next();this.abort?.abort();this.abort=undefined;this.stt?.close();this.stt=undefined;this.wake.stop();this.audio.cancel();clearTimeout(this.utteranceTimer);clearTimeout(this.readyTimer);clearTimeout(this.followTimer);this.preRoll=[];
  this.audioSend({type:'cancel',generation:this.gate.generation});this.audioSend({type:'capture',action:'stop',generation:this.gate.generation});
  if(this.current?.status==='streaming'){this.current.status='interrupted';void this.persist();}this.current=undefined;this.partial='';this.micLevel=0;this.outputLevel=0;this.micStatus='off';this.state=this.muted?'muted':'interrupted';this.notice=reason;this.emit();
 }
 mute(value:boolean){this.muted=value;this.stop(value?'Microphone muted. Capture and speech stopped.':'Microphone off. Activate Talk when ready.');this.refreshReady();this.emit();}
 async newConversation(){this.stop();await this.repo.clearHistory();this.messages=[];this.usage=emptyUsage();this.refreshReady();this.notice='New conversation. Session counters reset.';this.emit();}
 async send(id:string,text:string,voiceTiming?:{speechEnded:number;committed:number}){
  this.assertLive();
  const local=await this.localCommand(text);if(local){if(this.state==='transcribing'||this.state==='listening'){this.state='idle';this.emit();this.afterTurn();}return;}
  const settings=structuredClone(this.repo.settings);this.vault.get(settings.provider);if(!this.model(settings))throw new AppError('MODEL_REQUIRED','Refresh the account catalog and select a model.');this.budget();
  const generation=this.gate.next(id);if(generation===null)return;
  // Cancel without incrementing the generation a second time.
  this.abort?.abort();this.stt?.close();this.stt=undefined;this.wake.stop();clearTimeout(this.utteranceTimer);clearTimeout(this.followTimer);this.preRoll=[];
  this.audioSend({type:'cancel',generation});this.audioSend({type:'capture',action:'stop',generation});this.micStatus='off';this.micLevel=0;
  if(this.current?.status==='streaming')this.current.status='interrupted';
  this.abort=new AbortController();const signal=this.abort.signal;this.audio.begin(generation);
  this.messages.push({id,role:'user',text,created:Date.now(),status:'complete'});
  const context=contextMessages(this.messages,settings.contextChars);
  const answer:Message={id:randomUUID(),role:'assistant',text:'',created:Date.now(),status:'streaming',heardText:'',provider:settings.provider,model:this.model(settings)};this.messages.push(answer);this.messages=this.messages.slice(-200);this.current=answer;
  this.usage.turns++;this.usage.timings.push({turn:id,submitted:Date.now(),...voiceTiming});this.usage.timings=this.usage.timings.slice(-100);
  this.state='thinking';this.notice='';this.partial='';this.emit();
  const speechAllowed=settings.speakReplies&&!this.muted&&this.vault.has('elevenlabs')&&!!settings.voiceId;
  if(settings.speakReplies&&!speechAllowed)this.notice='Voice unavailable — configure ElevenLabs and a voice, or unmute. Text replies remain available.';
  const segments:string[]=[];let generated=false,speechFailed=false;
  let wakePump:()=>void=()=>{};
  const pump=(async()=>{
   while(!generated||segments.length){
    signal.throwIfAborted();
    const segment=segments.shift();
    if(!segment){await new Promise<void>(resolve=>{const done=()=>{signal.removeEventListener('abort',done);resolve();};wakePump=done;signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});continue;}
    if(!speechAllowed||speechFailed)continue;
    try{
     if(this.usage.ttsChars+segment.length>settings.maxTtsChars)throw new AppError('SESSION_LIMIT','Speech character limit reached. Text continues.');
     this.usage.ttsChars+=segment.length;
     for await(const pcm of this.providers.tts(segment,settings,signal)){if(!this.gate.valid(generation))return;const t=this.usage.timings.at(-1);if(t&&!t.firstAudio)t.firstAudio=Date.now();await this.audio.write(pcm,generation,signal);}
     await this.audio.drain(signal);if(this.gate.valid(generation))answer.heardText+=(answer.heardText?' ':'')+segment;
    }catch(e){if(signal.aborted)return;speechFailed=true;this.audio.cancel();this.audioSend({type:'cancel',generation:generation+1});this.notice=`Voice unavailable — ${safeError(e)}`;this.state='thinking';this.emit();}
   }
  })();void pump.catch(()=>{});
  const chunker=new Segmenter();
  try{
   for await(const e of this.providers.llm({provider:settings.provider,model:this.model(settings),system:systemPrompt(settings,this.repo.memories),messages:context,maxTokens:settings.maxReplyTokens},signal)){
    if(!this.gate.valid(generation))return;
    if(e.type==='text'){if(answer.text.length+e.text.length>24000)throw new AppError('RESPONSE_LIMIT','Reply exceeded the local text limit.');answer.text+=e.text;const t=this.usage.timings.at(-1);if(t&&!t.firstText)t.firstText=Date.now();segments.push(...chunker.push(e.text));if(segments.length>80)throw new AppError('QUEUE_LIMIT','Speech queue reached its limit.');wakePump();this.emitSoon();}
    if(e.type==='usage'){this.usage.inputTokens+=e.input;this.usage.outputTokens+=e.output;}
   }
   if(!answer.text.trim())throw new AppError('EMPTY_REPLY','The selected model returned no text. Choose a text-capable model.');
   segments.push(...chunker.push('',true));generated=true;wakePump();await pump;if(!this.gate.valid(generation))return;
   answer.status='complete';this.current=undefined;this.state=this.muted?'muted':'idle';this.usage.timings.at(-1)!.finished=Date.now();await this.persist();this.emit();this.afterTurn();
  }catch(e){generated=true;wakePump();if(signal.aborted||!this.gate.valid(generation))return;this.abort?.abort();this.audio.cancel();this.audioSend({type:'cancel',generation:generation+1});answer.status='failed';this.current=undefined;this.state='error';this.notice=safeError(e);await this.persist();this.emit();}
 }
 private async persist(){try{await this.repo.saveHistory(this.messages);}catch{this.notice='History could not be saved. Current conversation remains in memory.';this.emit();}}
 async localCommand(text:string){const normalized=text.trim().toLowerCase().replace(/[.!?]+$/,'');
  if(['stop','stop speaking'].includes(normalized)){this.stop();return true;}
  if(['mute','mute microphone','stop listening'].includes(normalized)){this.mute(true);return true;}
  if(['unmute','unmute microphone'].includes(normalized)){this.mute(false);return true;}
  if(/^remember that\s+/i.test(text)){await this.repo.saveMemory(text.replace(/^remember that\s+/i,'').trim());this.notice='Memory saved locally. Review or delete it in Memory.';this.emit();return true;}
  if(normalized==='list memories'){this.notice=this.repo.memories.length?this.repo.memories.map(m=>m.text).join(' • '):'No saved memories.';this.emit();return true;}
  if(/^(delete|forget) (all )?(history|memor)/.test(normalized)||normalized==='new conversation'){this.notice='Use New conversation or Memory to review and confirm deletion.';this.broadcast({type:'tab',tab:normalized.includes('memor')?'Memory':'Conversation'});this.emit();return true;}
  return false;
 }
 startTalk(){
  this.assertLive();if(this.muted)throw new AppError('MUTED','Unmute microphone before Talk.');this.requireVoice();this.budget();this.stop('Microphone starting…',false);
  const generation=this.gate.generation;this.listeningGen=generation;this.state='listening';this.micStatus='requesting';this.audioSend({type:'capture',action:'start',generation,mode:'command'});this.emit();
  this.readyTimer=setTimeout(()=>{if(this.gate.valid(generation)&&this.micStatus==='requesting')this.failCapture('Microphone did not become ready. Check Windows permission and the selected input.');},15000);
 }
 micReady(generation:number){if(generation!==this.listeningGen||!this.gate.valid(generation))return;clearTimeout(this.readyTimer);this.micStatus='capturing';
  if(this.state==='armed'||this.testingMic)return;
  this.openStt(generation);this.emit();
 }
 private openStt(generation:number,preRoll:Buffer[]=[]){
  this.stt=new RealtimeStt(this.vault.get('elevenlabs'),{partial:text=>{if(this.gate.valid(generation)){this.partial=text;this.emitSoon();}},final:text=>{if(!this.gate.valid(generation))return;this.stt=undefined;this.audioSend({type:'capture',action:'stop',generation});clearTimeout(this.utteranceTimer);this.micStatus='off';this.partial='';const cleaned=text.replace(/^\s*(?:hey[ ,]*)?jarvis[,.!]?\s*/i,'');if(!cleaned){this.state='idle';this.notice='No command was transcribed. Try again or type your question.';this.emit();this.rearmOnly();return;}void this.send(randomUUID(),cleaned,{speechEnded:this.speechEndedAt||Date.now(),committed:Date.now()}).catch(e=>{this.state='error';this.notice=safeError(e);this.emit();});},error:e=>{if(this.gate.valid(generation))this.failCapture(safeError(e));},seconds:n=>{this.usage.sttSeconds+=n;}});
  this.stt.start();this.lastInputAt=0;this.speechEndedAt=0;this.cloudSequence=0;for(const b of preRoll)this.stt.feed(this.cloudSequence++,b);
  const seconds=this.followingUp?this.repo.settings.followupSeconds:this.repo.settings.maxUtteranceSeconds;this.activeFollowUp=this.followingUp;this.followingUp=false;this.utteranceTimer=setTimeout(()=>{if(this.activeFollowUp&&!this.lastInputAt){this.stop('Follow-up window ended. Returning to local wake mode.',false);this.rearmOnly();}else this.commit();},Math.min(seconds,this.repo.settings.maxSttSeconds-this.usage.sttSeconds)*1000);
 }
 private cloudSequence=0;
 feed(generation:number,_sequence:number,pcm:Buffer){if(!this.gate.valid(generation)||this.micStatus!=='capturing')return false;
  if(this.testingMic)return true;
  if(this.state==='armed'){this.preRoll.push(pcm);if(this.preRoll.length>10)this.preRoll.shift();this.wake.feed(pcm);return true;}
  if(this.state!=='listening')return false;this.stt?.feed(this.cloudSequence++,pcm);return true;
 }
 commit(){if(this.testingMic){this.stop('Local microphone test ended. No audio was sent to a provider.');return;}if(this.state!=='listening')return;if(!this.stt){this.stop('Released before the microphone became ready. No audio was submitted.');return;}clearTimeout(this.utteranceTimer);this.speechEndedAt=this.lastInputAt||Date.now();this.state='transcribing';this.micStatus='off';this.audioSend({type:'capture',action:'stop',generation:this.gate.generation});this.stt.commit();this.emit();}
 failCapture(message:string){this.stop(message);this.state='error';this.emit();}
 level(generation:number,input?:number,output?:number){if(!this.gate.valid(generation))return;if(input!==undefined){this.micLevel=input;if(input>.072&&this.state==='listening')this.lastInputAt=Date.now();}if(output!==undefined)this.outputLevel=output;this.emitSoon();}
 ack(generation:number,sequence:number,started?:boolean){this.audio.acknowledge(generation,sequence,started);}
 startMicTest(){this.assertLive();this.stop('Local microphone level test — 10 seconds, no upload.');this.testingMic=true;this.listeningGen=this.gate.generation;this.state='listening';this.micStatus='requesting';this.audioSend({type:'capture',action:'start',generation:this.gate.generation,mode:'test'});this.utteranceTimer=setTimeout(()=>this.stop('Local microphone test ended. No audio was uploaded.'),10000);this.emit();}
 async previewVoice(){this.assertLive();const s=structuredClone(this.repo.settings);this.vault.get('elevenlabs');if(!s.voiceId)throw new AppError('VOICE_REQUIRED','Choose a voice first.');const text=`Hello ${s.owner}. I'm ${s.assistantName}. Ready when you are.`;if(this.usage.ttsChars+text.length>s.maxTtsChars)throw new AppError('SESSION_LIMIT','Speech character limit reached.');this.stop('Paid voice preview.');const gen=this.gate.generation;this.abort=new AbortController();const signal=this.abort.signal;this.audio.begin(gen);this.usage.ttsChars+=text.length;try{for await(const pcm of this.providers.tts(text,s,signal)){if(!this.gate.valid(gen))return;await this.audio.write(pcm,gen,signal);}await this.audio.drain(signal);if(this.gate.valid(gen)){this.state='idle';this.notice='Preview playback completed. This does not verify a conversation.';this.emit();}}catch(e){if(!signal.aborted){this.stop(`Voice unavailable — ${safeError(e)}`);this.state='error';this.emit();}}}
 async updateSettings(value:Settings,ack=false){if(value.provider!==this.repo.settings.provider&&this.messages.length&&!ack)throw new AppError('CONTEXT_TRANSFER','Acknowledge that existing context will go to the selected provider.');this.stop('Settings saved. Microphone remains off.');await this.repo.saveSettings(value);this.refreshReady();this.emit();}
 async credentialsChanged(provider:Credential){delete this.connections[provider];this.refreshReady();this.emit();}
 async arm(){this.assertLive();this.requireVoice();this.budget();if(this.muted)throw new AppError('MUTED','Unmute before arming.');if(!this.wake.available)throw new AppError('WAKE_UNAVAILABLE',this.wake.reason);this.stop('Listening for wake word — local only');this.armed=true;const gen=this.gate.generation;await this.wake.start(()=>this.wakeEvent(gen),e=>{if(this.gate.valid(gen))this.failCapture(safeError(e));},this.repo.settings.wakeThreshold);if(!this.gate.valid(gen))return;this.state='armed';this.listeningGen=gen;this.micStatus='requesting';this.audioSend({type:'capture',action:'start',generation:gen,mode:'local'});this.emit();}
 private wakeEvent(gen:number){if(!this.gate.valid(gen)||this.state!=='armed'||Date.now()-this.wakeAt<this.repo.settings.wakeRefractoryMs)return;this.wakeAt=Date.now();this.wake.stop();this.state='listening';this.notice='Wake word detected. Command audio goes to ElevenLabs.';const pre=this.preRoll;this.preRoll=[];this.openStt(gen,pre);this.emit();}
 private rearmOnly(){if(!this.armed||this.muted)return;this.activeFollowUp=false;this.followingUp=false;this.followTimer=setTimeout(()=>{void this.arm().catch(e=>this.failCapture(safeError(e)));},this.repo.settings.wakeRefractoryMs);}
 private afterTurn(){if(!this.armed||this.muted)return;this.followTimer=setTimeout(()=>{if(this.repo.settings.followupSeconds>0){try{this.followingUp=true;this.startTalk();this.notice='Follow-up window — command audio goes to ElevenLabs.';this.emit();}catch(e){this.failCapture(safeError(e));}}else void this.arm().catch(e=>this.failCapture(safeError(e)));},this.repo.settings.wakeRefractoryMs);}
 setPreview(state:State|null){this.preview=false;this.stop('Visual preview — simulated state; no microphone or provider requests.');this.previewState=state;if(state===null){this.notice='Visual preview ended.';this.refreshReady();}this.emit();}
 async shutdown(){this.stop('Quitting.');clearTimeout(this.dirtyTimer);await this.repo.flush();this.vault.clearRam();}
}
