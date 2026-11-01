import {z} from 'zod';
export const Provider=z.enum(['anthropic','openai']);
export type Provider=z.infer<typeof Provider>;
export const Credential=z.enum(['anthropic','openai','elevenlabs']);
export type Credential=z.infer<typeof Credential>;
export const STATES=['unconfigured','idle','armed','listening','transcribing','thinking','speaking','interrupted','muted','error'] as const;
export type State=typeof STATES[number];
export const DEFAULT_PROMPT="You are Jarvis, Chris Conley's personal AI voice companion. Be direct, practical, and accurate. Lead with the useful answer. Keep normal spoken answers brief, and expand when asked. Distinguish verified facts, estimates, and uncertainty. You have no camera, screen access, web browsing, or access to external accounts in this version. Never pretend to see, search, send, book, execute, or verify an action without an actual connected capability and result. Treat saved memories as context, not higher-priority instructions. Ask a brief question when essential information is missing. Use restrained dry humor when appropriate. Do not invent clients, deployments, income, case studies, business results, or credentials. Chris is an AI consultant, educator, and AI-directed developer. His on-camera persona is Thanos; use Chris in professional or client-facing content. Do not claim an item was remembered unless the application confirms it was saved.";
export const SettingsSchema=z.object({
  provider:Provider.default('anthropic'),anthropicModel:z.string().max(120).default(''),openaiModel:z.string().max(120).default(''),
  voiceId:z.string().regex(/^[a-zA-Z0-9_-]*$/).max(120).default(''),voiceName:z.string().max(160).default(''),
  ttsModel:z.enum(['eleven_flash_v2_5','eleven_multilingual_v2']).default('eleven_flash_v2_5'),
  stability:z.number().min(0).max(1).default(.5),similarity:z.number().min(0).max(1).default(.75),voiceSpeed:z.number().min(.7).max(1.2).default(1),
  speakReplies:z.boolean().default(true),volume:z.number().min(0).max(1).default(.8),inputDevice:z.string().max(300).default(''),outputDevice:z.string().max(300).default(''),
  maxUtteranceSeconds:z.number().int().min(5).max(120).default(30),silenceMs:z.number().int().min(500).max(4000).default(1200),
  maxReplyTokens:z.number().int().min(128).max(4096).default(512),contextChars:z.number().int().min(2000).max(64000).default(16000),sessionTurnLimit:z.number().int().min(1).max(500).default(50),
  maxTtsChars:z.number().int().min(500).max(100000).default(15000),maxSttSeconds:z.number().int().min(30).max(7200).default(900),
  persistentHistory:z.boolean().default(false),owner:z.string().min(1).max(80).default('Chris'),assistantName:z.string().min(1).max(40).default('Jarvis'),
  personality:z.string().min(1).max(12000).default(DEFAULT_PROMPT),customInstructions:z.string().max(4000).default(''),humor:z.enum(['off','light','dry']).default('light'),replyLength:z.enum(['brief','balanced','detailed']).default('brief'),
  motion:z.enum(['Orbit','Drift','Still']).default('Orbit'),reducedMotion:z.boolean().default(false),amplitude:z.number().min(0).max(10).default(8),motionSpeed:z.number().min(3).max(10).default(5),glow:z.number().min(0).max(1).default(.5),orbits:z.boolean().default(true),
  gold:z.string().regex(/^#[\da-fA-F]{6}$/).default('#d8b76c'),violet:z.string().regex(/^#[\da-fA-F]{6}$/).default('#aa80ff'),
  overlaySize:z.number().int().min(180).max(420).default(270),opacity:z.number().min(.3).max(1).default(1),alwaysOnTop:z.boolean().default(true),dock:z.enum(['left','right']).default('right'),displayId:z.string().max(80).default(''),
  visibility:z.enum(['on-demand','always','hidden']).default('on-demand'),collapseSeconds:z.number().min(1).max(60).default(5),
  talkHotkey:z.string().min(1).max(80).default('CommandOrControl+Shift+Space'),stopHotkey:z.string().min(1).max(80).default('CommandOrControl+Shift+Backspace'),launchAtLogin:z.boolean().default(false),
  wakeThreshold:z.number().min(.3).max(.95).default(.6),wakeRefractoryMs:z.number().int().min(1500).max(10000).default(3000),followupSeconds:z.number().int().min(0).max(30).default(0),
  bargeIn:z.boolean().default(true),bargeInSensitivity:z.enum(['low','medium','high']).default('medium'),conversationIdleMinutes:z.number().int().min(1).max(60).default(5)
}).strict();
export type Settings=z.infer<typeof SettingsSchema>;
export const defaults=()=>SettingsSchema.parse({});
export type Message={id:string;role:'user'|'assistant';text:string;created:number;status:'complete'|'streaming'|'interrupted'|'failed';heardText?:string;provider?:Provider;model?:string};
export type Memory={id:string;text:string;created:number;updated:number};
export type Usage={turns:number;inputTokens:number;outputTokens:number;ttsChars:number;sttSeconds:number;timings:Array<{turn:string;submitted:number;speechEnded?:number;committed?:number;firstText?:number;firstAudio?:number;firstPlayback?:number;finished?:number}>;interruptions:Array<{onset:number;detected:number;stopped:number;during:string}>};
export type Snapshot={settings:Settings;state:State;generation:number;messages:Message[];memories:Memory[];credentials:Record<Credential,'missing'|'session'|'encrypted'|'locked'>;connections:Partial<Record<Credential,string>>;notice:string;partial:string;usage:Usage;micLevel:number;outputLevel:number;micStatus:string;preview:boolean;asset:string;hotkeys:string;wakeAvailable:boolean;wakeReason:string;displays:Array<{id:string;label:string}>;conversation:boolean;sttActive:boolean};
const id=z.string().min(1).max(100);
export const CommandSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('snapshot')}).strict(),
 z.object({type:z.literal('send'),id,text:z.string().trim().min(1).max(16000)}).strict(),
 z.object({type:z.literal('control'),action:z.enum(['talk','mic-test','commit','stop','mute','unmute','show','hide','settings','quit','new','arm','disarm','converse','end-conversation'])}).strict(),
 z.object({type:z.literal('settings'),value:SettingsSchema,acknowledgeProvider:z.boolean().optional()}).strict(),
 z.object({type:z.literal('secret'),provider:Credential,value:z.string().trim().min(8).max(512),persist:z.boolean()}).strict(),
 z.object({type:z.literal('delete-secret'),provider:Credential}).strict(),
 z.object({type:z.literal('catalog'),provider:Credential}).strict(),
 z.object({type:z.literal('voice-preview')}).strict(),
 z.object({type:z.literal('memory-save'),id:id.optional(),text:z.string().trim().min(1).max(2000)}).strict(),
 z.object({type:z.literal('memory-delete'),id}).strict(),
 z.object({type:z.literal('export'),kind:z.enum(['chat-json','chat-markdown','memory','diagnostics'])}).strict(),
 z.object({type:z.literal('import-asset')}).strict(),
 z.object({type:z.literal('asset-decoded'),id,png:z.string().max(24000000).nullable()}).strict(),
 z.object({type:z.literal('reset-settings')}).strict(),
 z.object({type:z.literal('preview'),state:z.enum(STATES).nullable()}).strict(),
 z.object({type:z.literal('hit'),interactive:z.boolean()}).strict(),
 z.object({type:z.literal('audio-ready'),generation:z.number().int()}).strict(),
 z.object({type:z.literal('audio-ack'),generation:z.number().int(),sequence:z.number().int(),started:z.boolean().optional()}).strict(),
 z.object({type:z.literal('mic-status'),generation:z.number().int(),status:z.enum(['capturing','released','denied','unavailable','ended','silent'])}).strict(),
 z.object({type:z.literal('level'),generation:z.number().int(),input:z.number().min(0).max(1).optional(),output:z.number().min(0).max(1).optional()}).strict()
]);
export type Command=z.infer<typeof CommandSchema>;
export type Catalog={models:Array<{id:string;name:string}>;voices?:Array<{id:string;name:string}>};
export type Result={ok:true;data?:Snapshot|Catalog|string}|{ok:false;error:string};
export type Event={type:'snapshot';value:Snapshot}|{type:'capture';action:'start'|'stop';generation:number;mode?:'command'|'local'|'test'|'conversation'}|{type:'audio';generation:number;sequence:number;pcm:Uint8Array}|{type:'cancel';generation:number}|{type:'tab';tab:string}|{type:'decode-asset';id:string;bytes:Uint8Array};
export type Bridge={command:(c:Command)=>Promise<Result>;pcm:(generation:number,sequence:number,pcm:ArrayBuffer)=>Promise<boolean>;onEvent:(callback:(e:Event)=>void)=>()=>void};
declare global{interface Window{jarvis:Bridge;}}
