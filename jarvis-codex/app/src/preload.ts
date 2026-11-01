import {contextBridge,ipcRenderer} from 'electron';
import type {Bridge,Command,Event} from './shared';
const bridge:Bridge={
 command:(command:Command)=>ipcRenderer.invoke('jarvis:command',command),
 pcm:(generation:number,sequence:number,pcm:ArrayBuffer)=>ipcRenderer.invoke('jarvis:pcm',generation,sequence,pcm),
 onEvent:(callback:(event:Event)=>void)=>{const listener=(_event:Electron.IpcRendererEvent,payload:Event)=>callback(payload);ipcRenderer.on('jarvis:event',listener);return ()=>ipcRenderer.removeListener('jarvis:event',listener);}
};
contextBridge.exposeInMainWorld('jarvis',Object.freeze(bridge));
