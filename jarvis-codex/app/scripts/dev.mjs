// A reproducible production-origin dev launch avoids a second permission policy.
import {spawn} from 'node:child_process';
const build=spawn(process.execPath,['scripts/build.mjs'],{stdio:'inherit'});
build.on('exit',async code=>{if(code)process.exit(code);const {default:electron}=await import('electron');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;const child=spawn(electron,['.'],{stdio:'inherit',env});child.on('exit',c=>process.exit(c??0));});
