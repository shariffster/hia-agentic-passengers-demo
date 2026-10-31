import {readFile,writeFile,lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createMockTrace,runComparison,traceFromExport} from './scenario.mjs';
import {buildBundle} from './bundle.mjs';
import {executeDaytona} from './transport.mjs';
const ROOT=dirname(fileURLToPath(import.meta.url));
async function main(){
  const [command,...args]=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){if(!['--trace','--out','--credential-file','--credit-cap-usd','--export'].includes(args[i])||!args[i+1])throw Error('Invalid arguments');options[args[i]]=args[i+1];}
  if(!['local','daytona','convert','fixture'].includes(command))throw Error('Use local, daytona, fixture or convert');
  if(command==='convert'){
    if(!options['--export']||!options['--out'])throw Error('Convert needs --export and --out');
    const trace=traceFromExport(JSON.parse(await readFile(options['--export'],'utf8')));await runComparison(trace);
    await writeFile(options['--out'],JSON.stringify(trace,null,2)+'\n');console.log('Sanitized replay saved and locally verified.');return;
  }
  const trace=options['--trace']?JSON.parse(await readFile(options['--trace'],'utf8')):await createMockTrace();
  if(command==='fixture'){await writeFile(options['--out']??resolve(ROOT,'artifacts/mock-trace.json'),JSON.stringify(trace,null,2)+'\n');return;}
  const result=await runComparison(trace),bundle=await buildBundle(ROOT,trace);
  let envelope={schema:'hia.daytona.execution/1',execution:{provider:'local',status:'local_verified',sandboxId:null,bundleHash:bundle.sha256,resultMatchesLocal:true,cleanup:'not_applicable',liveDaytonaVerified:false},result,sourceFiles:bundle.manifest};
  if(command==='daytona'){
    if(!options['--credential-file']||!options['--credit-cap-usd'])throw Error('Live execution requires an explicit private credential file and approved credit cap');
    const path=resolve(options['--credential-file']);if(path.startsWith(ROOT+'/'))throw Error('Credential file must be outside runner/repository');
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid()||stat.size>4096)throw Error('Credential file must be owned private regular file');
    const config=JSON.parse(await readFile(path,'utf8'));
    if(Object.keys(config).some(k=>k!=='DAYTONA_API_KEY')||typeof config.DAYTONA_API_KEY!=='string'||config.DAYTONA_API_KEY.length<10)throw Error('Invalid credential file');
    const {Daytona}=await import('@daytona/sdk');
    const client=new Daytona({apiKey:config.DAYTONA_API_KEY,apiUrl:'https://app.daytona.io/api',requestTimeoutMs:30000,otelEnabled:false});
    try{envelope=await executeDaytona({client,bundle,expected:result,creditCapUsd:Number(options['--credit-cap-usd'])});}
    finally{if(client[Symbol.asyncDispose])await client[Symbol.asyncDispose]();}
  }
  const out=options['--out']??resolve(ROOT,'artifacts/'+command+'.json');
  await writeFile(out,JSON.stringify(envelope,null,2)+'\n');
  console.log(JSON.stringify({status:envelope.execution.status,cleanup:envelope.execution.cleanup,resultMatchesLocal:envelope.execution.resultMatchesLocal,artifact:out,comparison:envelope.result?.comparison},null,2));
  if(!['local_verified','live_verified'].includes(envelope.execution.status))process.exitCode=1;
}
main().catch(()=>{console.error('Runner failed. Check input, private credential-file permissions and SDK availability. No credential-bearing error details emitted.');process.exitCode=1;});
