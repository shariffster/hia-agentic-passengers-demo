import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
export const SANDBOX_POLICY = Object.freeze({snapshot:'daytona-small',language:'javascript',public:false,networkBlockAll:true,autoStopInterval:2,autoDeleteInterval:0,ttlMinutes:5,ephemeral:true,labels:{purpose:'hia-synthetic-replay'}});
export const ESTIMATED_FIVE_MINUTE_USD=(0.0504+0.0162)*5/60;
export async function executeDaytona({client,bundle,expected,creditCapUsd=0.01,clock=()=>new Date().toISOString()}) {
  if(!Number.isFinite(creditCapUsd)||creditCapUsd<ESTIMATED_FIVE_MINUTE_USD||creditCapUsd>50)throw Error('Credit cap must cover the small sandbox estimate and must not exceed approved $50');
  const name='hia-replay-'+randomUUID().slice(0,12);
  const receipt={provider:'Daytona',status:'not_started',sandboxName:name,sandboxId:null,startedAt:clock(),finishedAt:null,phase:'create',cleanup:'not_started',policy:SANDBOX_POLICY,creditCapUsd,
    estimatedFiveMinuteComputeMemoryUsd:ESTIMATED_FIVE_MINUTE_USD,billingActualUsd:null,billingNote:'Estimate only. Single small sandbox, 5 minute TTL. No billing API measurement or provider dollar-cap guarantee.',bundleHash:bundle.sha256,resultMatchesLocal:false};
  let sandbox,remote;
  try {
    receipt.status='running';
    sandbox=await client.create({...structuredClone(SANDBOX_POLICY),name},{timeout:45});
    receipt.sandboxId=sandbox.id;
    receipt.phase='resource_check';
    receipt.resources={cpu:sandbox.cpu,memoryGiB:sandbox.memory,diskGiB:sandbox.disk};
    if(!Number.isFinite(sandbox.cpu)||sandbox.cpu>1||sandbox.cpu<1||sandbox.memory!==1||!Number.isFinite(sandbox.disk)||sandbox.disk>3)throw Error('Unexpected sandbox resources');
    receipt.phase='upload';
    await sandbox.fs.createFolder('/tmp/hia-replay/vendor','700');
    await sandbox.fs.uploadFiles(bundle.files.map(f=>({source:f.source,destination:'/tmp/hia-replay/'+f.path})),30);
    receipt.phase='execute';
    const execution=await sandbox.process.executeCommand('node sandbox-entry.mjs','/tmp/hia-replay',{},30);
    receipt.exitCode=execution.exitCode;
    if(execution.exitCode!==0)throw Error('Sandbox execution failed');
    receipt.phase='download';
    const bytes=await sandbox.fs.downloadFile('/tmp/hia-replay/result.json',30);
    if(bytes.length>2000000)throw Error('Oversized sandbox result');
    remote=JSON.parse(bytes.toString());
    receipt.resultMatchesLocal=isDeepStrictEqual(remote,expected);
    if(!receipt.resultMatchesLocal)throw Error('Remote replay differs from local');
    receipt.status='execution_verified';
  } catch(error) {
    receipt.status='failed';
    // Intentionally do not forward SDK errors: URLs, headers or credentials may be included.
    receipt.errorCode='daytona_'+receipt.phase+'_failed';
    if(!sandbox){
      receipt.cleanup='resource_creation_uncertain';
      try { sandbox=await client.get(name); receipt.sandboxId=sandbox.id; } catch { /* TTL is a second cleanup guard; do not create again. */ }
    }
  } finally {
    if(sandbox){
      receipt.cleanup='deleting';
      try { await client.delete(sandbox,30,true); receipt.cleanup='deleted'; } catch { receipt.cleanup='delete_unconfirmed'; }
    }
    receipt.finishedAt=clock();
  }
  if(receipt.status==='execution_verified'&&receipt.cleanup==='deleted')receipt.status='live_verified';
  return {schema:'hia.daytona.execution/1',execution:receipt,result:remote??null,sourceFiles:bundle.manifest};
}
