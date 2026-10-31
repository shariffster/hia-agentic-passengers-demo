/** New standalone fixture. Coordinates are metres on an invented 120 m corridor. */
export const SYNTHETIC_SPATIAL = Object.freeze({
  graph:{
    nodes:[
      {id:'a_0',kind:'gate',position:[0,0,0],access:'airside'},
      {id:'a_1',kind:'gate',position:[120,0,0],access:'airside'},
      {id:'plaza_north',kind:'junction',position:[0,10,0],access:'airside'},
    ],
    edges:[
      {from:'a_0',to:'a_1',lengthMeters:120,stepFree:true,allowedAccess:['airside']},
      {from:'a_0',to:'plaza_north',lengthMeters:10,stepFree:true,allowedAccess:['airside']},
    ],
    services:[],
  },
});
