/** Aggregate actual engine positions; never invent offsets to imply a larger crowd.
 * Cells count all cases and retain selected IDs. Movement is still free-flow. */
export function aggregateMacroFrame(frame,{cellMetres=5}={}){
  if(!Number.isFinite(cellMetres)||cellMetres<=0)throw Error('Invalid cell size');
  const cells=new Map();
  for(const point of frame.points){
    const [x,y,z]=point.position;
    if(![x,y,z].every(Number.isFinite))throw Error('Invalid engine position');
    const ix=Math.floor(x/cellMetres),iy=Math.floor(y/cellMetres),iz=Math.floor(z/cellMetres),key=`${ix}:${iy}:${iz}`;
    let cell=cells.get(key);
    if(!cell){cell={key,bounds:{x:[ix*cellMetres,(ix+1)*cellMetres],y:[iy*cellMetres,(iy+1)*cellMetres],z:[iz*cellMetres,(iz+1)*cellMetres]},count:0,states:{},selectedIds:[]};cells.set(key,cell);}
    cell.count++;cell.states[point.state]=(cell.states[point.state]??0)+1;
    if(point.selected)cell.selectedIds.push(point.id);
  }
  const result={schema:'hia.scale.density/1',time:frame.time,population:frame.population,policyCounts:structuredClone(frame.policyCounts),counts:structuredClone(frame.counts),selected:structuredClone(frame.selected),cells:[...cells.values()],rendered:false,notice:'Counts aggregate actual semantic positions. Overlapping cases are not spread into invented physical positions. This is not pedestrian density or safe-capacity analysis.'};
  if(result.cells.reduce((sum,c)=>sum+c.count,0)!==frame.population)throw Error('Macro population mismatch');
  return result;
}
