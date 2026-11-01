import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Controller} from '../src/main/controller';
import {Providers,RealtimeStt,type LlmEvent,type LlmRequest} from '../src/main/providers';
import {Repository,Vault} from '../src/main/storage';
import {WakeEngine} from '../src/main/wake';
import type {Event} from '../src/shared';
import {concat,mix,packets,silence,ttsChunk,voiced} from './audio-fixtures';

type Callbacks=ConstructorParameters<typeof RealtimeStt>[1];
class FakeStt{
 fed:number[]=[];commits=0;closed=false;started=false;
 constructor(private cb:Callbacks){}
 start(){this.started=true;}
 feed(seq:number){if(!this.closed)this.fed.push(seq);}
 commit(){this.commits++;}
 close(){if(this.closed)return;this.closed=true;this.cb.seconds(this.fed.length*.08);}
 finalize(text:string){this.closed=true;this.cb.seconds(this.fed.length*.08);this.cb.final(text);}
 fail(e:unknown){this.closed=true;this.cb.error(e);}
}
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function until(cond:()=>boolean,label:string,limit=4000){for(let i=0;i<limit&&!cond();i++)await tick();assert(cond(),`timed out waiting for: ${label}`);}

const live:Controller[]=[];
// Always release timers/sessions, even when an assertion fails mid-test.
afterEach(async()=>{while(live.length)await live.pop()!.shutdown();});
const SENTENCES=['Here is the first full sentence of the long story. ','Here is the second full sentence that nobody hears. ','And a third sentence that should never be spoken.'];
async function fixture(opts:{autoAck?:boolean;chunks?:number}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'jarvis-conversation-fixture-'));const repo=new Repository(dir);await repo.load();
 await repo.saveSettings({...repo.settings,anthropicModel:'fixture-model',voiceId:'fixture-voice'});
 const vault=new Vault(dir,{available:async()=>false,encrypt:async()=>Buffer.alloc(0),decrypt:async()=>''});await vault.set('anthropic','fixture-key',false);await vault.set('elevenlabs','fixture-key',false);
 const providers=new Providers(p=>vault.get(p));const llmCalls:LlmRequest[]=[];
 let script:(r:LlmRequest)=>AsyncGenerator<LlmEvent>=async function*(){for(const t of SENTENCES)yield {type:'text',text:t};yield {type:'usage',input:3,output:9};yield {type:'done'};};
 providers.llm=async function*(r){llmCalls.push(r);yield* script(r);};
 const chunks=opts.chunks??30;providers.tts=async function*(){for(let i=0;i<chunks;i++)yield ttsChunk(-20);};
 const events:Event[]=[];const queue:Array<{generation:number;sequence:number}>=[];let playing:{generation:number;sequence:number}|undefined;
 const c=new Controller(repo,vault,providers,e=>{if(e.type!=='snapshot')events.push(e);},e=>{events.push(e);if(e.type==='audio'){if(opts.autoAck)queueMicrotask(()=>{c.ack(e.generation,e.sequence,true);c.ack(e.generation,e.sequence);});else queue.push({generation:e.generation,sequence:e.sequence});}if(e.type==='cancel'){queue.length=0;playing=undefined;}},new WakeEngine('',[]));live.push(c);
 const stts:FakeStt[]=[];c.createStt=(_key,cb)=>{const s=new FakeStt(cb);stts.push(s);return s as unknown as RealtimeStt;};
 let clock=50_000;c.now=()=>clock;let seq=0;
 /** Simulated renderer playback: one 100 ms chunk starts per 80 ms tick; the previous one ends. */
 const playStep=()=>{if(playing){c.ack(playing.generation,playing.sequence);playing=undefined;}const next=queue.shift();if(next){c.ack(next.generation,next.sequence,true);playing=next;}};
 const feed=async(signal:Float32Array,{play=false}={})=>{const gen=c['captureGen' as keyof Controller] as unknown as number;for(const p of packets(signal)){clock+=80;if(play)playStep();c.feed(gen,seq++,Buffer.from(p.buffer));await tick();}};
 const begin=()=>{c.startConversation();const gen=c['captureGen' as keyof Controller] as unknown as number;c.micReady(gen);return gen;};
 return {c,repo,llmCalls,setScript:(s:typeof script)=>{script=s;},events,stts,feed,begin,queue};
}
const speech=(ms=700)=>voiced(ms,-22,150);
const echo=(ms:number)=>voiced(ms,-46,110);
const say=async(f:Awaited<ReturnType<typeof fixture>>,text:string,{play=false}={})=>{await f.feed(concat(speech(),silence(1500)),{play});const stt=f.stts.at(-1)!;assert.equal(stt.commits,1,'utterance committed after the pause');stt.finalize(text);};

test('conversation keeps one microphone session across a full voice turn and only streams speech to ElevenLabs',async()=>{
 const f=await fixture({autoAck:true});const {c,events,stts,llmCalls}=f;
 f.begin();const start=events.findLast(e=>e.type==='capture'&&e.action==='start');
 assert.equal(start&&start.type==='capture'&&start.mode,'conversation');assert.equal(c.micStatus,'capturing');assert.equal(c.snapshot().conversation,true);
 await f.feed(silence(1500));assert.equal(stts.length,0,'silence is never sent to the cloud');assert.equal(c.usage.sttSeconds,0);
 await f.feed(speech());assert.equal(stts.length,1);assert(stts[0].fed.length>=4,'pre-roll fed');assert.equal(c.snapshot().sttActive,true);
 await f.feed(silence(1500));assert.equal(stts[0].commits,1);assert.equal(c.state,'transcribing');assert.equal(c.snapshot().sttActive,false);
 stts[0].finalize('What is on my plan today?');
 await until(()=>c.messages.at(-1)?.status==='complete','reply complete');
 assert.equal(llmCalls.length,1);assert.equal(llmCalls[0].messages.at(-1)?.content,'What is on my plan today?');
 const stopsAfterStart=events.slice(events.indexOf(start!)+1).filter(e=>e.type==='capture'&&e.action==='stop');
 assert.equal(stopsAfterStart.length,0,'microphone never stopped between turns');
 assert.equal(c.micStatus,'capturing');assert.equal(c.state,'listening');assert.equal(c.conversation,true);
 await c.shutdown();
});

test('speaking over Jarvis stops playback immediately, keeps the first words, and answers the correction',async()=>{
 const f=await fixture();const {c,events,stts,llmCalls}=f;f.begin();
 await f.feed(silence(1000));await say(f,'Tell me a long story');
 await until(()=>f.queue.length>0,'speech audio queued');
 await f.feed(echo(4000),{play:true});
 assert.equal(c.state,'speaking');assert.equal(c.usage.interruptions.length,0,'echo of Jarvis alone does not interrupt');assert.equal(stts.length,1);
 const answer=c.messages.at(-1)!;assert.equal(answer.status,'streaming');
 const responseGen=c.gate.generation;
 await f.feed(mix(echo(600),speech(600)),{play:true});
 assert.equal(c.usage.interruptions.length,1,'barge-in detected');
 const cancel=events.findIndex(e=>e.type==='cancel'&&e.generation>responseGen);assert(cancel>=0,'local cancel sent to the renderer');
 const [i]=c.usage.interruptions;assert(i.stopped-i.onset<=450,`onset→stop ${i.stopped-i.onset} ms (fixture clock)`);assert.equal(i.during,'speaking');
 assert.equal(answer.status,'interrupted');assert.equal(answer.heardText,SENTENCES[0].trim(),'only fully played text counts as heard');
 assert.equal(stts.length,2,'interruption utterance opened');assert(stts[1].fed.length>=4,'pre-roll before detection preserved');
 await f.feed(concat(speech(300),silence(1500)));
 assert.equal(events.slice(cancel+1).filter(e=>e.type==='audio'&&e.generation<=responseGen).length,0,'no late audio from the old reply');
 f.setScript(async function*(){yield {type:'text',text:'Short version: it ends well.'};yield {type:'done'};});
 stts[1].finalize('Actually keep it short');
 await until(()=>llmCalls.length===2,'second request');
 const ctx=llmCalls[1].messages;assert.equal(ctx.at(-1)?.content,'Actually keep it short');assert(ctx.some(m=>m.role==='assistant'&&m.content.includes('Interrupted reply')),'honest interrupted context');
 assert.equal(c.conversation,true);assert.equal(c.micStatus,'capturing');
 await c.shutdown();
});

test('talking again while Jarvis is still thinking merges both parts into one turn',async()=>{
 const f=await fixture();const {c,stts,llmCalls}=f;f.begin();
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 f.setScript(async function*(){await wait;yield {type:'text',text:'LATE STALE ANSWER. '};yield {type:'done'};});
 await f.feed(silence(1000));await say(f,'Tell me the time');
 await until(()=>c.state==='thinking','thinking');
 f.setScript(async function*(){yield {type:'text',text:'It is noon and sunny.'};yield {type:'done'};});
 await f.feed(concat(speech(),silence(1500)));
 assert.equal(c.usage.interruptions.length,1);assert.equal(c.usage.interruptions[0].during,'thinking');
 assert.equal(c.messages.filter(m=>m.role==='user').length,0,'unheard turn withdrawn, waiting for the rest');
 stts.at(-1)!.finalize('and the weather');
 await until(()=>llmCalls.length===2,'merged request');
 assert.equal(llmCalls[1].messages.at(-1)?.content,'Tell me the time and the weather');
 release();await tick();await tick();
 assert(!c.messages.some(m=>m.text.includes('LATE STALE ANSWER')),'aborted reply never lands');
 assert.equal(c.messages.filter(m=>m.role==='user').length,1);
 await c.shutdown();
});

test('a pause that splits one sentence before the transcript returns is sent once, joined',async()=>{
 const f=await fixture({autoAck:true});const {c,stts,llmCalls}=f;f.begin();
 await f.feed(silence(1000));await f.feed(concat(speech(),silence(1500)));
 await f.feed(speech());assert.equal(stts.length,2,'second utterance started before the first transcript');
 stts[0].finalize('Book the room');await tick();
 assert.equal(llmCalls.length,0,'held while the user is still talking');
 await f.feed(silence(1500));stts[1].finalize('for Thursday at noon');
 await until(()=>llmCalls.length===1,'joined request');assert.equal(llmCalls[0].messages.at(-1)?.content,'Book the room for Thursday at noon');
 await c.shutdown();
});

test('"yeah" after an interruption is treated as an acknowledgement, not a new request',async()=>{
 const f=await fixture();const {c,stts,llmCalls}=f;f.begin();
 await f.feed(silence(1000));await say(f,'Explain the plan');await until(()=>f.queue.length>0,'audio');
 await f.feed(echo(3000),{play:true});await f.feed(mix(echo(600),speech(600)),{play:true});
 assert.equal(c.usage.interruptions.length,1);await f.feed(silence(1500));stts.at(-1)!.finalize('Yeah.');await tick();
 assert.equal(llmCalls.length,1);assert.match(c.notice,/Heard “Yeah\.”/);assert.equal(c.state,'listening');
 await c.shutdown();
});

test('rapid repeated interruptions never leave stale responses or audio',async()=>{
 const f=await fixture();const {c,events,llmCalls}=f;f.begin();await f.feed(silence(1000));
 for(let round=0;round<3;round++){
  await say(f,`Question ${round}`);await until(()=>f.queue.length>0,`audio round ${round}`);
  await f.feed(echo(1600),{play:true});const gen=c.gate.generation;
  await f.feed(mix(echo(600),speech(600)),{play:true});
  const cancel=events.findIndex(e=>e.type==='cancel'&&e.generation>gen);assert(cancel>=0,`round ${round} cancelled`);
  await f.feed(silence(1500));f.stts.at(-1)!.finalize('');await tick();
  assert.equal(events.slice(cancel+1).filter(e=>e.type==='audio'&&e.generation<=gen).length,0,`round ${round}: no stale audio`);
 }
 assert.equal(c.usage.interruptions.length,3);assert.equal(llmCalls.length,3);assert.equal(c.conversation,true);
 assert.equal(c.messages.filter(m=>m.status==='streaming').length,0);
 await c.shutdown();
});

test('Interrupt button and Talk/commit during a conversation stop speech but keep listening',async()=>{
 const f=await fixture();const {c}=f;f.begin();await f.feed(silence(1000));await say(f,'Long answer please');await until(()=>f.queue.length>0,'audio');
 await f.feed(echo(800),{play:true});c.commit();
 assert.equal(c.conversation,true);assert.equal(c.micStatus,'capturing');assert.equal(c.messages.at(-1)?.status,'interrupted');
 c.manualInterrupt();assert.equal(c.conversation,true);
 await c.shutdown();
});

test('end, Stop and Mute each release the microphone; stale capture is rejected; re-entry works',async()=>{
 const f=await fixture({autoAck:true});const {c,events,stts}=f;
 const gen=f.begin();await f.feed(silence(1000));await f.feed(speech());
 c.endConversation();
 assert.equal(c.conversation,false);assert.equal(c.micStatus,'off');assert.equal(stts[0].closed,true,'open speech session closed');
 assert.equal(events.at(-1)?.type==='capture'&&(events.at(-1) as {action:string}).action,'stop');
 assert.equal(c.feed(gen,999,Buffer.alloc(2560)),false,'stale capture rejected');
 const gen2=f.begin();assert.notEqual(gen2,gen);assert.equal(c.conversation,true);
 c.stop();assert.equal(c.conversation,false);assert.equal(c.micStatus,'off');
 f.begin();c.mute(true);assert.equal(c.conversation,false);assert.equal(c.micStatus,'off');assert.equal(c.state,'muted');
 assert.throws(()=>c.startConversation(),/Unmute/);c.mute(false);
 c.setPreview('speaking');assert.throws(()=>c.startConversation(),/Exit visual preview/);c.setPreview(null);
 await c.shutdown();
});

test('"stop" keeps the conversation; "end conversation" ends it; repeated speech-service errors end it safely',async()=>{
 const f=await fixture({autoAck:true});const {c,stts,llmCalls}=f;f.begin();await f.feed(silence(1000));
 await say(f,'Stop');await tick();assert.equal(c.conversation,true);assert.equal(llmCalls.length,0);assert.match(c.notice,/Still listening/);
 await say(f,'End conversation');await tick();assert.equal(c.conversation,false);assert.equal(c.micStatus,'off');
 f.begin();await f.feed(silence(1000));
 await f.feed(concat(speech(),silence(1500)));stts.at(-1)!.fail(new Error('network down'));assert.equal(c.conversation,true,'one error: keep listening');
 await f.feed(concat(speech(),silence(1500)));stts.at(-1)!.fail(new Error('network down'));
 assert.equal(c.conversation,false);assert.equal(c.state,'error');assert.equal(c.micStatus,'off');
 await c.shutdown();
});

test('provider failure during a conversation ends it with the microphone off (no repeated paid attempts)',async()=>{
 const f=await fixture({autoAck:true});const {c}=f;f.begin();await f.feed(silence(1000));
 f.setScript(async function*(){throw new Error('provider 402');yield {type:'done'};});
 await say(f,'Hello there');await until(()=>!c.conversation,'conversation ended');
 assert.equal(c.state,'error');assert.equal(c.micStatus,'off');assert.match(c.notice,/Conversation ended/);
 await c.shutdown();
});

test('spoken interruption can be turned off: Jarvis finishes while you talk',async()=>{
 const f=await fixture();const {c,repo}=f;await c.updateSettings({...repo.settings,bargeIn:false});f.begin();await f.feed(silence(1000));
 await say(f,'Tell me something');await until(()=>f.queue.length>0,'audio');
 await f.feed(echo(2000),{play:true});await f.feed(mix(echo(800),speech(800)),{play:true});
 assert.equal(c.usage.interruptions.length,0);assert.equal(c.messages.at(-1)?.status,'streaming');
 await c.shutdown();
});
