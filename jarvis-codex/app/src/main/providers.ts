import WebSocket from 'ws';
import {AppError,httpError,type Segmenter} from '../core';
import type {Catalog,Credential,Provider,Settings} from '../shared';
export type LlmEvent={type:'text';text:string}|{type:'usage';input:number;output:number}|{type:'done'};
export type LlmRequest={provider:Provider;model:string;system:string;messages:Array<{role:'user'|'assistant';content:string}>;maxTokens:number};
export type KeyGetter=(provider:Credential)=>string;
export async function* parseSse(body:ReadableStream<Uint8Array>,signal:AbortSignal):AsyncGenerator<Record<string,unknown>>{
 const reader=body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r/g,'');if(buffer.length>1048576)throw new AppError('STREAM_LIMIT','Provider event exceeded the local limit.');
  let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(data&&data!=='[DONE]'){try{yield JSON.parse(data) as Record<string,unknown>;}catch(e){if(e instanceof SyntaxError)throw new AppError('INVALID_STREAM','Provider returned malformed data.');throw e;}}}
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function llmPayload(r:LlmRequest):Record<string,unknown>{return r.provider==='anthropic'?{model:r.model,system:r.system,messages:r.messages,max_tokens:r.maxTokens,stream:true}:{model:r.model,instructions:r.system,input:r.messages,max_output_tokens:r.maxTokens,stream:true,store:false};}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'?v as Record<string,unknown>:{};
export class Providers{
 constructor(private key:KeyGetter,private request:typeof fetch=fetch){}
 private async get(url:string,provider:Credential,signal?:AbortSignal){const headers:Record<string,string>=provider==='openai'?{Authorization:`Bearer ${this.key(provider)}`}:provider==='anthropic'?{'x-api-key':this.key(provider),'anthropic-version':'2023-06-01'}:{'xi-api-key':this.key(provider)};const response=await this.request(url,{headers,redirect:'error',signal:signal??AbortSignal.timeout(15000)});if(!response.ok)throw httpError(response.status);return response;}
 async catalog(p:Credential):Promise<Catalog>{
  if(p==='elevenlabs'){
   const [models,voices]=await Promise.all([this.get('https://api.elevenlabs.io/v1/models',p).then(r=>r.json()),this.get('https://api.elevenlabs.io/v2/voices?page_size=100',p).then(r=>r.json())]);
   return {models:(Array.isArray(models)?models:[]).filter(m=>obj(m).can_do_text_to_speech).map(m=>({id:String(obj(m).model_id),name:String(obj(m).name)})),voices:(Array.isArray(obj(voices).voices)?obj(voices).voices as unknown[]:[]).map(v=>({id:String(obj(v).voice_id),name:String(obj(v).name)}))};
  }
  const url=p==='anthropic'?'https://api.anthropic.com/v1/models?limit=1000':'https://api.openai.com/v1/models';const json=await (await this.get(url,p)).json();
  const list=Array.isArray(obj(json).data)?obj(json).data as unknown[]:[];
  return {models:list.map(m=>({id:String(obj(m).id),name:String(obj(m).display_name??obj(m).id)})).filter(m=>p==='anthropic'||!/embedding|whisper|tts|audio|realtime|image|moderation|dall-e|transcribe/i.test(m.id))};
 }
 async *llm(r:LlmRequest,abort:AbortSignal):AsyncGenerator<LlmEvent>{
  if(!r.model)throw new AppError('MODEL_REQUIRED','Choose and test a model in Connections.');
  const signal=AbortSignal.any([abort,AbortSignal.timeout(90000)]),key=this.key(r.provider);
  const headers:Record<string,string>=r.provider==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01','Content-Type':'application/json'}:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  const response=await this.request(r.provider==='anthropic'?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/responses',{method:'POST',headers,body:JSON.stringify(llmPayload(r)),redirect:'error',signal});
  if(!response.ok)throw httpError(response.status);if(!response.body)throw new AppError('EMPTY_STREAM','No response stream was returned.');
  let input=0,output=0,complete=false;
  for await(const e of parseSse(response.body,signal)){
   if(e.type==='error'||e.type==='response.failed'||e.type==='response.incomplete')throw new AppError('PROVIDER_STREAM','Provider did not complete the reply. Check model/access, credits, or response limit.');
   if(r.provider==='anthropic'){
    if(e.type==='message_start'){const u=obj(obj(e.message).usage);input=Number(u.input_tokens??0);output=Number(u.output_tokens??0);}
    if(e.type==='content_block_start'&&obj(e.content_block).type==='tool_use')throw new AppError('UNSUPPORTED','No external tools are enabled.');
    if(e.type==='content_block_delta'&&obj(e.delta).type==='text_delta')yield {type:'text',text:String(obj(e.delta).text??'')};
    if(e.type==='message_delta'){output=Number(obj(e.usage).output_tokens??output);if(obj(e.delta).stop_reason==='max_tokens')throw new AppError('RESPONSE_LIMIT','Reply reached its token limit. Ask for a shorter reply or raise the limit.');}
    if(e.type==='message_stop')complete=true;
   }else{
    if(e.type==='response.output_text.delta')yield {type:'text',text:String(e.delta??'')};
    if(e.type==='response.refusal.delta')yield {type:'text',text:String(e.delta??'')};
    if(e.type==='response.completed'){const u=obj(obj(e.response).usage);input=Number(u.input_tokens??0);output=Number(u.output_tokens??0);complete=true;}
   }
  }
  if(!complete)throw new AppError('INCOMPLETE','Connection ended before the provider confirmed completion.');
  yield {type:'usage',input,output};yield {type:'done'};
 }
 async *tts(text:string,s:Settings,abort:AbortSignal):AsyncGenerator<Uint8Array>{
  if(!s.voiceId)throw new AppError('VOICE_REQUIRED','Choose an ElevenLabs voice first.');
  const signal=AbortSignal.any([abort,AbortSignal.timeout(45000)]);
  const response=await this.request(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(s.voiceId)}/stream?output_format=pcm_24000`,{method:'POST',headers:{'xi-api-key':this.key('elevenlabs'),'Content-Type':'application/json'},body:JSON.stringify({text,model_id:s.ttsModel,voice_settings:{stability:s.stability,similarity_boost:s.similarity,speed:s.voiceSpeed}}),redirect:'error',signal});
  if(!response.ok)throw httpError(response.status);if(!response.body)throw new AppError('EMPTY_AUDIO','No speech audio was returned.');
  const reader=response.body.getReader();let pending=Buffer.alloc(0),total=0;
  try{while(true){signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;pending=Buffer.concat([pending,Buffer.from(value)]);total+=value.length;if(total>8*1024*1024)throw new AppError('AUDIO_LIMIT','Speech exceeded the per-segment buffer limit.');while(pending.length>=4800){yield pending.subarray(0,4800);pending=pending.subarray(4800);}}if(pending.length%2)throw new AppError('INVALID_AUDIO','Incomplete PCM sample from speech provider.');if(pending.length)yield pending;if(!total)throw new AppError('EMPTY_AUDIO','Speech provider returned no samples.');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 }
}
export class RealtimeStt{
 private socket?:WebSocket;private ready=false;private closed=false;private pending:Buffer[]=[];private started=0;private lastSeq=-1;private commitRequested=false;private timer?:ReturnType<typeof setTimeout>;private inputBytes=0;
 constructor(private key:string,private callbacks:{partial:(s:string)=>void;final:(s:string)=>void;error:(e:unknown)=>void;seconds:(n:number)=>void}){}
 start(){
  this.started=Date.now();this.socket=new WebSocket('wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=manual',{headers:{'xi-api-key':this.key},handshakeTimeout:10000,maxPayload:131072});
  this.timer=setTimeout(()=>this.fail(new AppError('STT_TIMEOUT','Speech connection did not become ready.')),12000);
  this.socket.on('message',data=>{
   if(this.closed)return;
   try{const e=JSON.parse(data.toString());if(e.message_type==='session_started'){clearTimeout(this.timer);this.ready=true;for(const b of this.pending)this.send(b);this.pending=[];if(this.commitRequested)this.commit();}
    else if(e.message_type==='partial_transcript')this.callbacks.partial(String(e.text??''));
    else if(e.message_type==='committed_transcript'){const text=String(e.text??'').trim();this.close();this.callbacks.final(text);}
    else if(/error|auth|quota|rate_limit|resource_exhausted|insufficient|limit_exceeded/i.test(e.message_type??''))this.fail(new AppError('STT_REJECTED','Speech service rejected the session. Check credentials, access, credits and network.'));
   }catch{this.fail(new AppError('STT_FORMAT','Speech service returned malformed data.'));}
  });
  this.socket.on('error',()=>this.fail(new AppError('STT_CONNECTION','Speech connection failed. Typed chat is still available.')));
  this.socket.on('close',()=>{if(!this.closed)this.fail(new AppError('STT_CLOSED','Speech connection ended before a final transcript.'));});
 }
 feed(sequence:number,pcm:Buffer){if(this.closed||this.commitRequested)return;if(sequence!==this.lastSeq+1){this.fail(new AppError('AUDIO_ORDER','Microphone packets arrived out of order. Start a new utterance.'));return;}this.lastSeq=sequence;this.inputBytes+=pcm.length;if(!this.ready){this.pending.push(pcm);if(this.pending.length>60)this.fail(new AppError('STT_BACKPRESSURE','Speech connection is too slow; microphone stopped.'));return;}this.send(pcm);}
 private send(pcm:Buffer){if(this.socket?.readyState!==WebSocket.OPEN)return;if(this.socket.bufferedAmount>128000){this.fail(new AppError('STT_BACKPRESSURE','Speech upload stalled; microphone stopped.'));return;}this.socket.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:pcm.toString('base64'),sample_rate:16000}));}
 commit(){if(this.closed)return;this.commitRequested=true;if(!this.ready)return;if(this.inputBytes<16000){this.fail(new AppError('SHORT_AUDIO','Record at least half a second before sending.'));return;}this.socket?.send(JSON.stringify({message_type:'input_audio_chunk',audio_base_64:Buffer.alloc(3200).toString('base64'),sample_rate:16000,commit:true}));clearTimeout(this.timer);this.timer=setTimeout(()=>this.fail(new AppError('STT_TIMEOUT','No final transcript arrived. Retry explicitly or type your question.')),12000);}
 private fail(e:unknown){if(this.closed)return;this.close();this.callbacks.error(e);}
 close(){if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.pending=[];this.socket?.removeAllListeners();this.socket?.on('error',()=>{});if(this.socket?.readyState===WebSocket.CONNECTING)this.socket.terminate();else this.socket?.close();this.callbacks.seconds((Date.now()-this.started)/1000);}
}
// The sentence segmenter is independent of the transport and covered by fixtures.
export type SpeechSegmenter=Segmenter;
