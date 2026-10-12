import {cpSync, mkdirSync, existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..');
for(const name of ['cmaps','standard_fonts','wasm']){
 const from=join(root,'node_modules/pdfjs-dist',name);
 if(!existsSync(from))throw new Error(`Missing PDF.js ${name}; run npm ci first`);
 const to=join(root,'public/pdfjs',name);mkdirSync(to,{recursive:true});cpSync(from,to,{recursive:true});
}
console.log('Offline PDF.js fonts, maps and WASM copied.');
