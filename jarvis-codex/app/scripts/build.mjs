import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
import {mkdir,copyFile,readFile,writeFile} from 'node:fs/promises';
await mkdir('public',{recursive:true});
await copyFile('../assets/jarvis-character.png','public/jarvis-character.png');
await viteBuild({base:'./',build:{outDir:'dist/renderer',emptyOutDir:true},server:{host:'127.0.0.1',port:5187,strictPort:true}});
await build({entryPoints:['src/main/index.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:'dist/main.cjs',external:['electron'],sourcemap:false});
await build({entryPoints:['src/preload.ts'],bundle:true,platform:'node',target:'node24',format:'cjs',outfile:'dist/preload.cjs',external:['electron'],sourcemap:false});

const notices=[];for(const dependency of ['react','react-dom','scheduler','zod','ws'])notices.push(dependency+'\n'+await readFile('node_modules/'+dependency+'/LICENSE','utf8'));await writeFile('dist/THIRD_PARTY_NOTICES.txt',notices.join('\n\n'));
