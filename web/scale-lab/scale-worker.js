import {createScaleWorkerHandler} from './worker-handler.js';
const handle=createScaleWorkerHandler();
self.onmessage=event=>self.postMessage(handle(event.data));
