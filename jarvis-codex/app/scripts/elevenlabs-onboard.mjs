// Run with: node --env-file=.env.local scripts/elevenlabs-onboard.mjs
// Read-only SDK preflight, then encrypt the authorized key for the desktop app.
// Does not launch Jarvis, generate speech, change its voice, or expose credentials.
import {ElevenLabsClient} from '@elevenlabs/elevenlabs-js';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import electron from 'electron';

const allowed=new Set(['invalid_api_key','missing_permissions','payment_required','quota_exceeded','subscription_required','voice_not_found']);
try{
 if(!process.env.ELEVENLABS_API_KEY)throw new Error('KEY_REQUIRED');
 const client=new ElevenLabsClient({maxRetries:0,timeoutInSeconds:20});
 const [catalog,subscription]=await Promise.all([client.voices.search({pageSize:100}),client.user.subscription.get()]);
 let settings={};try{settings=JSON.parse(await readFile(path.join(process.env.APPDATA,'Jarvis Codex','settings.json'),'utf8'));}catch{/* Optional settings. */}
 const report={keyLast4:process.env.ELEVENLABS_API_KEY.slice(-4),voiceCatalogReached:true,voiceCount:catalog.voices.length,selectedVoiceConfigured:!!settings.voiceId,selectedVoiceFound:catalog.voices.some(v=>v.voiceId===settings.voiceId),subscriptionStatus:subscription.status,subscriptionTier:subscription.tier,hasOpenInvoices:subscription.hasOpenInvoices,usedCredits:subscription.characterCount,creditLimit:subscription.characterLimit};
 if(settings.voiceId&&!report.selectedVoiceFound){
  if(/^sk[_-]/i.test(settings.voiceId))report.selectedVoiceProblem='The voice ID field contains an API-key-shaped value';
  else try{await client.voices.get(settings.voiceId);report.selectedVoiceAccessible=true;}catch(error){report.selectedVoiceAccessible=false;report.selectedVoiceHttpStatus=error?.statusCode;const reason=error?.body?.detail?.status;report.selectedVoiceProblem=allowed.has(reason)?reason:'voice_lookup_rejected';}
 }
 if(process.argv.includes('--check-only')){console.log(JSON.stringify({...report,speechTested:false},null,2));process.exit(0);}
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const stored=await new Promise((resolve,reject)=>{
  const child=spawn(electron,['scripts/store-elevenlabs.mjs'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',bytes=>{output+=bytes.toString();});
  child.stderr.resume();child.on('error',()=>reject(new Error('STORE_FAILED')));
  child.on('exit',code=>{if(code!==0)return reject(new Error('STORE_FAILED'));try{resolve(JSON.parse(output));}catch{reject(new Error('STORE_FAILED'));}});
 });
 console.log(JSON.stringify({...report,...stored,restartRequired:true,speechTested:false},null,2));
}catch(error){
 const candidate=error?.body?.detail?.status;
 console.error(JSON.stringify({connected:false,httpStatus:Number.isInteger(error?.statusCode)?error.statusCode:undefined,reason:allowed.has(candidate)?candidate:'setup_failed_no_secret_logged'}));process.exitCode=1;
}
