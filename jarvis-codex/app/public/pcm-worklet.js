// Stateful box-filter resampling. Keeps fractional input positions across callbacks.
// 16 kHz mono signed little-endian PCM in exact 80 ms packets.
class PcmCapture extends AudioWorkletProcessor {
  constructor(){super();this.ratio=sampleRate/16000;this.phase=0;this.sum=0;this.weight=0;this.packet=new Int16Array(1280);this.at=0;}
  process(inputs){const channels=inputs[0];if(!channels||!channels.length)return true;const n=channels[0].length;
    for(let i=0;i<n;i++){let sample=0;for(const channel of channels)sample+=channel[i]||0;sample/=channels.length;let remaining=1;
      while(remaining>1e-7){const take=Math.min(remaining,this.ratio-this.phase);this.sum+=sample*take;this.weight+=take;this.phase+=take;remaining-=take;
        if(this.phase>=this.ratio-1e-7){const value=Math.max(-1,Math.min(1,this.sum/this.weight));this.packet[this.at++]=Math.round(value*(value<0?32768:32767));this.phase=0;this.sum=0;this.weight=0;if(this.at===1280){this.port.postMessage(this.packet.buffer,[this.packet.buffer]);this.packet=new Int16Array(1280);this.at=0;}}
      }
    }return true;
  }
}
registerProcessor('pcm-capture',PcmCapture);
