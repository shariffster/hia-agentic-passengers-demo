import {createScaleController} from './scale-controller.js';
import {aggregateMacroFrame} from './macro-density.js';
/** Synchronous worker-side protocol. Run IDs reject commands from a previous reset. */
export function createScaleWorkerHandler(){
  let controller=null,sequence=0,runId=null;
  return request=>{
    const requestId=typeof request?.requestId==='string'?request.requestId:null;
    try{
      if(!requestId||requestId.length>128)throw Error('Invalid request identity');
      if(request.type==='start'){
        // Build successfully before replacing an existing run.
        const fresh=createScaleController(request.options??{});controller?.dispose();controller=fresh;runId=`scale-${++sequence}`;
      }else{
        if(!controller)throw Error('No active run');
        if(request.runId!==runId)throw Error('Stale run');
        if(request.type==='inspect')return {requestId,runId,ok:true,inspector:controller.inspectPassenger(request.passengerId)};
        if(request.type==='advance')controller.advanceTo(request.time);
        else if(request.type==='dispose'){controller.dispose();controller=null;return {requestId,runId,ok:true,disposed:true};}
        else if(request.type!=='frame')throw Error('Unknown command');
      }
      const frame=controller.frame();
      return {requestId,runId,ok:true,frame:request.densityOnly?aggregateMacroFrame(frame):frame};
    }catch(error){return {requestId,runId,ok:false,error:String(error.message).slice(0,180)};}
  };
}
