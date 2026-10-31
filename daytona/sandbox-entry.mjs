import {readFile,writeFile} from 'node:fs/promises';
import {runComparison} from './scenario.mjs';
// The sandbox has no credentials and outbound network is blocked.
globalThis.fetch = async () => { throw Error('Network disabled in replay'); };
const result = await runComparison(JSON.parse(await readFile('trace.json','utf8')));
await writeFile('result.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:'complete',schema:result.schema,passengers:result.comparison.length,inferenceExecuted:false}));
