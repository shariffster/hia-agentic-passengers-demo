import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'EXPORT-MANIFEST.json'),'utf8'));
let checked=0;
for(const entry of manifest.files){
 const filename=path.resolve(root,entry.path);
 if(!filename.startsWith(root+path.sep))throw Error('Invalid manifest path');
 const bytes=fs.readFileSync(filename);
 if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Manifest mismatch: '+entry.path);
 if(/\.(m?js)$/.test(entry.path)){
  execFileSync(process.execPath,['--check',filename],{stdio:'pipe'});checked++;
  if(entry.path.startsWith('web/')){
   const source=bytes.toString('utf8');
   for(const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)){
    const dependency=path.resolve(path.dirname(filename),match[1].split('?')[0]);
    if(!dependency.startsWith(root+path.sep)||!fs.existsSync(dependency))throw Error('Missing public import: '+entry.path+' → '+match[1]);
   }
  }
 }
}
for(const required of ['server.py','web/index.html','web/standalone.css','web/recordings/nosana-live-run.json','web/evidence/daytona/report.html','web/scale-lab/index.html']){
 if(!fs.existsSync(path.join(root,required)))throw Error('Missing runnable artifact: '+required);
}
console.log(`Static app ready: ${manifest.files.length} file hashes and ${checked} JavaScript modules verified. No transpilation, credentials, network access or paid calls required. Start with npm start or python3 -B server.py --port 58741.`);
