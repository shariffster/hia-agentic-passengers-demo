import {readFile,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {hash,validateTrace} from './scenario.mjs';
export const ENGINE_FILES=['gate-agent-demo.js','recovery-world.js','recovery-simulation.js','simulation.js','holding-layout.js','synthetic-graph.js'].map(n=>'vendor/'+n);
export async function buildBundle(root,trace) {
  const manifest=JSON.parse(await readFile(resolve(root,'engine-manifest.json'),'utf8'));
  if(manifest.files.length!==ENGINE_FILES.length||manifest.files.some((f,i)=>f.path!==ENGINE_FILES[i]))throw Error('Unexpected engine manifest');
  const files=[];
  for(const path of [...ENGINE_FILES,'scenario.mjs','sandbox-entry.mjs']){
    const absolute=resolve(root,path),stat=await lstat(absolute);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>300000)throw Error('Unsafe bundle file');
    const source=await readFile(absolute);
    const pinned=manifest.files.find(f=>f.path===path);
    if(pinned&&hash(source.toString())!==pinned.sha256)throw Error('Engine source hash changed');
    files.push({path,source});
  }
  files.push({path:'package.json',source:Buffer.from('{"type":"module"}')});
  files.push({path:'trace.json',source:Buffer.from(JSON.stringify(validateTrace(trace)))});
  const fileManifest=files.map(f=>({path:f.path,bytes:f.source.length,sha256:hash(f.source.toString())}));
  return {files,manifest:fileManifest,sha256:hash(fileManifest)};
}
