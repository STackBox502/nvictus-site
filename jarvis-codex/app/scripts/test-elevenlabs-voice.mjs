// One explicitly authorized paid test. No retries; no microphone capture.
import {app,safeStorage} from 'electron';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.join(app.getPath('appData'),'Jarvis Codex');
app.setPath('userData',root);app.disableHardwareAcceleration();
const reasons=new Set(['invalid_api_key','missing_permissions','quota_exceeded','paid_plan_required','payment_required','subscription_required','subscription_payment_failed','voice_not_found','subscription_inactive','subscription_expired','feature_not_available','insufficient_credits','detected_unusual_activity']);
async function failure(response){
 const body=await response.json().catch(()=>({})),status=body?.detail?.status,message=typeof body?.detail?.message==='string'?body.detail.message:'';
 return {httpStatus:response.status,reason:reasons.has(status)?status:'unclassified_provider_error',missingPermissions:['text_to_speech','speech_to_text','models_read','voices_read','user_read'].filter(p=>message.includes(p)),mentionsInvoice:/invoice/i.test(message),mentionsPayment:/payment|billing|past.due/i.test(message)};
}
async function main(){
 await app.whenReady();
 const key=(await safeStorage.decryptStringAsync(await readFile(path.join(root,'credentials','elevenlabs.vault')))).result;
 const settings=JSON.parse(await readFile(path.join(root,'settings.json'),'utf8'));
 if(!settings.voiceId||!settings.ttsModel)throw new Error('CONFIG_REQUIRED');
 const report={keyLast4:key.slice(-4),model:settings.ttsModel,phrase:'Jarvis voice test.',speechRequests:1};
 const models=await fetch('https://api.elevenlabs.io/v1/models',{headers:{'xi-api-key':key},redirect:'error',signal:AbortSignal.timeout(15000)});
 report.models=models.ok?{httpStatus:models.status}:await failure(models);
 const response=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}/stream?output_format=pcm_24000`,{method:'POST',headers:{'xi-api-key':key,'Content-Type':'application/json'},body:JSON.stringify({text:report.phrase,model_id:settings.ttsModel,voice_settings:{stability:settings.stability,similarity_boost:settings.similarity,speed:settings.voiceSpeed}}),redirect:'error',signal:AbortSignal.timeout(45000)});
 if(!response.ok)report.speech=await failure(response);
 else{
  const pcm=Buffer.from(await response.arrayBuffer());if(!pcm.length||pcm.length%2||pcm.length>2400000)throw new Error('INVALID_TEST_AUDIO');
  const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(24000,24);header.writeUInt32LE(48000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);
  await mkdir('test-results',{recursive:true});await writeFile('test-results/elevenlabs-voice-test.wav',Buffer.concat([header,pcm]));
  report.speech={httpStatus:200,audioBytes:pcm.length,durationSeconds:pcm.length/48000,file:'test-results/elevenlabs-voice-test.wav'};
 }
 await mkdir('test-results',{recursive:true});await writeFile('test-results/elevenlabs-live-test.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(()=>{console.error('Voice test could not complete; no credentials or provider payloads logged.');process.exitCode=1;}).finally(()=>app.exit(process.exitCode||0));
