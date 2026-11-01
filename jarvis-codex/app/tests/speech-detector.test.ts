import test from 'node:test';
import assert from 'node:assert/strict';
import {EchoReference,isBackchannel,pcmDb,SpeechDetector,TUNING,type DetectorEvent,type EchoLevel} from '../src/speech-detector';
import {clicks,concat,hum,mix,noise,packets,silence,ttsChunk,voiced} from './audio-fixtures';

type Run={events:DetectorEvent[];detector:SpeechDetector};
/** Feeds 80 ms packets; `echoAt(t)` supplies the playback reference for each packet end time (ms). */
function run(signal:Float32Array,{start=0,echoAt=(_t:number):EchoLevel=>({playing:false,refDb:-Infinity}),detector=new SpeechDetector(TUNING.medium,1200)}={}):Run{
 const events:DetectorEvent[]=[];let t=start;
 for(const p of packets(signal)){t+=80;events.push(...detector.process(p,t,echoAt(t)));}
 return {events,detector};
}
const starts=(r:Run)=>r.events.filter(e=>e.type==='start') as Extract<DetectorEvent,{type:'start'}>[];
const ends=(r:Run)=>r.events.filter(e=>e.type==='end') as Extract<DetectorEvent,{type:'end'}>[];

test('voiced speech starts a turn within ~300 ms and ends after the configured pause',()=>{
 const r=run(concat(silence(1000),voiced(1200,-22),silence(2000)));
 const [s]=starts(r),[e]=ends(r);
 assert.equal(starts(r).length,1);assert(s,'speech start detected');
 assert(s.detectedAt-1000<=300,`detection delay ${s.detectedAt-1000} ms`);
 assert(Math.abs(s.onsetAt-1000)<=100,`onset estimate ${s.onsetAt}`);
 assert(e,'speech end detected');assert(Math.abs(e.endedAt-2200)<=120,`end estimate ${e.endedAt}`);
 assert(e.detectedAt-e.endedAt>=1200&&e.detectedAt-e.endedAt<=1300,'end waits for the silence setting');
});

test('a thinking pause shorter than the silence setting keeps one turn',()=>{
 const r=run(concat(silence(1000),voiced(900,-22),silence(700),voiced(900,-22),silence(2000)));
 assert.equal(starts(r).length,1);assert.equal(ends(r).length,1);
});

test('keyboard clicks never start a turn',()=>{
 assert.equal(starts(run(concat(silence(800),clicks(4000,.6)))).length,0);
});

test('steady fan noise is learned as the floor; speech on top still triggers',()=>{
 const fan=noise(7000,-38);
 assert.equal(starts(run(fan.slice(0,4*16000))).length,0);
 const r=run(mix(fan,concat(silence(4000),voiced(1000,-20),silence(2000))));
 const [s]=starts(r);assert.equal(starts(r).length,1);assert(s.detectedAt>=4000&&s.detectedAt<=4350);
});

test('hum present at start is calibrated away; hum that begins later is released as stationary noise',()=>{
 assert.equal(starts(run(hum(5000,-35))).length,0);
 const r=run(concat(silence(1500),hum(8000,-35)));
 assert(starts(r).length<=1,'at most one false start');
 if(starts(r).length){const [s]=starts(r),[e]=ends(r);assert(e&&e.detectedAt-s.detectedAt<=3600,'stationary guard ends it');}
});

test('very short sounds do not start a turn (idle) or interrupt (playback)',()=>{
 assert.equal(starts(run(concat(silence(1000),voiced(120,-20),silence(1500)))).length,0);
 const playing=():EchoLevel=>({playing:true,refDb:-20});
 const d=new SpeechDetector(TUNING.medium,1200,-30);
 assert.equal(starts(run(concat(silence(1000),voiced(200,-20),silence(1500)),{echoAt:playing,detector:d})).length,0);
});

test('Jarvis echo from laptop speakers alone never triggers; the user talking over it does',()=>{
 const ref=-20,playing=(t:number):EchoLevel=>t>1000?{playing:true,refDb:ref}:{playing:false,refDb:-Infinity};
 const echoOnly=concat(silence(1000),voiced(8000,-46,110));
 const a=run(echoOnly,{echoAt:playing});
 assert.equal(starts(a).length,0,'no self-interruption from echo');
 assert(a.detector.couplingDb<-18,`learned coupling ${a.detector.couplingDb.toFixed(1)} dB`);
 const b=run(concat(echoOnly,mix(voiced(1000,-46,110,1),voiced(1000,-22,150)),voiced(1500,-46,110,2)),{echoAt:(t)=>t<=10000?playing(t):{playing:true,refDb:ref}});
 const [s]=starts(b);assert.equal(starts(b).length,1,'barge-in detected');assert(s.duringPlayback);
 assert(s.detectedAt-9000<=420,`interruption detection ${s.detectedAt-9000} ms after the user started`);
});

test('loud echo on the first reply (no learned coupling yet) stays below the strict start threshold',()=>{
 const r=run(concat(silence(1000),voiced(8000,-28,110)),{echoAt:(t)=>t>1000?{playing:true,refDb:-20}:{playing:false,refDb:-Infinity}});
 assert.equal(starts(r).length,0);
});

test('sensitivity presets order the margins sensibly',()=>{
 assert(TUNING.low.echoMarginDb>TUNING.medium.echoMarginDb&&TUNING.medium.echoMarginDb>TUNING.high.echoMarginDb);
 assert(TUNING.low.onsetPlaybackMs>TUNING.high.onsetPlaybackMs);
});

test('echo reference tracks played chunks, keeps a reverb tail, and truncates on stop',()=>{
 const e=new EchoReference(400);e.add(-20,1000,100);e.add(-30,1100,100);
 assert.deepEqual(e.level(1050),{playing:true,refDb:-20});
 assert.equal(e.level(1500).playing,true);assert.equal(e.level(1700).playing,false);
 e.add(-18,2000,100);e.truncate(2010);assert.equal(e.level(2200).playing,false);
 assert(Math.abs(pcmDb(ttsChunk(-20))+20)<.2);
});

test('backchannel detection is limited to brief acknowledgements',()=>{
 for(const t of ['Yeah.','mm-hmm','OK','uh huh','Got it!'])assert(isBackchannel(t),t);
 for(const t of ['yeah but what about tomorrow','No','Wait, change that','go on'])assert(!isBackchannel(t),t);
});
