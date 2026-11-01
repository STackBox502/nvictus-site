import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('worklet resampling preserves packet size and channel averaging at 48/44.1 kHz',()=>{
 for(const rate of [48000,44100]){
  const packets:ArrayBuffer[]=[];let Processor:new()=>{process:(input:Float32Array[][])=>boolean};
  class Base{port={postMessage:(buffer:ArrayBuffer)=>packets.push(buffer)};}
  runInNewContext(readFileSync('public/pcm-worklet.js','utf8'),{AudioWorkletProcessor:Base,sampleRate:rate,Int16Array,Math,registerProcessor:(_name:string,p:typeof Processor)=>{Processor=p;}});
  const processor=new Processor!();const frames=Math.round(rate*.8);for(let i=0;i<frames;i+=128){const size=Math.min(128,frames-i);processor.process([[new Float32Array(size).fill(.6),new Float32Array(size).fill(.2)]]);}
  assert.equal(packets.length,10);assert(packets.every(b=>b.byteLength===2560));for(const b of packets)assert(new Int16Array(b).every(v=>Math.abs(v-13107)<=1));
 }
});
