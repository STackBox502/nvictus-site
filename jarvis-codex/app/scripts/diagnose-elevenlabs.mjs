// Read-only account diagnosis. Never prints a secret or raw provider response.
import {app,safeStorage} from 'electron';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.join(app.getPath('appData'),'Jarvis Codex');
app.setPath('userData',root);app.disableHardwareAcceleration();
const known=new Set(['invalid_api_key','missing_permissions','quota_exceeded','paid_plan_required','payment_required','subscription_required','voice_not_found','subscription_inactive','subscription_expired','feature_not_available','authentication_error','authorization_error','insufficient_credits','subscription_not_found']);
async function main(){
 await app.whenReady();
 let key;
 try{key=(await safeStorage.decryptStringAsync(await readFile(path.join(root,'credentials','elevenlabs.vault')))).result;}
 catch{console.log(JSON.stringify({savedKey:'missing_or_locked',note:'A session-only key cannot be checked outside the running app.'}));return;}
 const report={savedKey:'encrypted',keyLast4:key.slice(-4),checks:[]};
 let settings={};try{settings=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));}catch{/* Optional settings. */}
 report.selectedVoice=typeof settings.voiceId==='string'&&!!settings.voiceId;
 report.speechModel=typeof settings.ttsModel==='string'?settings.ttsModel:'default';
 for(const route of ['/v1/user','/v1/user/subscription','/v2/voices?page_size=100']){
  try{
   const response=await fetch('https://api.elevenlabs.io'+route,{headers:{'xi-api-key':key},redirect:'error',signal:AbortSignal.timeout(15000)});
   const body=await response.json();
   const entry={route,httpStatus:response.status};
   if(!response.ok){const code=body?.detail?.status??body?.error?.code;entry.reason=known.has(code)?code:'unclassified_provider_error';const message=typeof body?.detail?.message==='string'?body.detail.message:'';entry.missingTextToSpeechPermission=/missing.*permission.*text_to_speech/i.test(message);entry.missingSpeechToTextPermission=/missing.*permission.*speech_to_text/i.test(message);}
   else if(route.endsWith('/subscription')){
    for(const field of ['status','tier','character_count','character_limit','can_use_instant_voice_cloning','can_use_professional_voice_cloning']){const value=body[field];if(['string','number','boolean'].includes(typeof value))entry[field]=value;}
   }else if(route.includes('/voices'))entry.selectedVoiceInCatalog=Array.isArray(body.voices)&&body.voices.some(v=>v.voice_id===settings.voiceId);
   report.checks.push(entry);
  }catch{report.checks.push({route,networkError:true});}
 }
 console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Read-only diagnosis failed; no sensitive details logged.');process.exitCode=1;}).finally(()=>app.quit());
