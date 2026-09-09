import {createSculptureSampler} from './lighting-camera.js';
import {surfaceFragmentCandidates,surfaceFragmentEventsAt,surfaceFragmentPose} from '../render/surface-fragments.js';

function project(point) {
  const factor=3.8/(3.8-point[2]);
  return {x:point[0]*factor,y:point[1]*factor,z:point[2]};
}

/** Choose genuinely exposed parts of the captured surface, including self occlusion. */
export function selectVisibleFragments(values,event,seed) {
  const sample=createSculptureSampler(values),columns=48,rows=24,vertices=[];
  for(let v=0;v<=rows;v++)for(let u=0;u<=columns;u++)vertices.push(project(sample(u/columns,v/rows)));
  const triangles=[];
  for(let v=0;v<rows;v++)for(let u=0;u<columns;u++) {
    const a=v*(columns+1)+u,b=a+1,c=a+columns+1,d=c+1;
    triangles.push([vertices[a],vertices[b],vertices[c]],[vertices[b],vertices[d],vertices[c]]);
  }
  const visible=[];
  for(const piece of surfaceFragmentCandidates(event,seed)) {
    const point=sample(piece.u,piece.v),p=project(point),u=sample(piece.u+0.0008,piece.v),v=sample(piece.u,piece.v+0.0008);
    const a=u.map((value,i)=>value-point[i]),b=v.map((value,i)=>value-point[i]);
    const normal=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const view=[-point[0],-point[1],3.8-point[2]],normalLength=Math.hypot(...normal),viewLength=Math.hypot(...view);
    const facing=normal.reduce((sum,value,i)=>sum+value*view[i],0)/Math.max(1e-9,normalLength*viewLength);
    if(facing<0.06)continue;
    let front=-Infinity;
    for(const [a,b,c] of triangles) {
      if(p.x<Math.min(a.x,b.x,c.x)||p.x>Math.max(a.x,b.x,c.x)||p.y<Math.min(a.y,b.y,c.y)||p.y>Math.max(a.y,b.y,c.y))continue;
      const denominator=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
      if(Math.abs(denominator)<1e-9)continue;
      const s=((b.y-c.y)*(p.x-c.x)+(c.x-b.x)*(p.y-c.y))/denominator;
      const t=((c.y-a.y)*(p.x-c.x)+(a.x-c.x)*(p.y-c.y))/denominator;
      if(s>=0&&t>=0&&s+t<=1)front=Math.max(front,s*a.z+t*b.z+(1-s-t)*c.z);
    }
    if(p.z<front-0.055)continue;
    let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
    for(let i=0;i<12;i++) {
      const angle=i/12*Math.PI*2,q=project(sample(piece.u+Math.cos(angle)*piece.halfU,piece.v+Math.sin(angle)*piece.halfV));
      left=Math.min(left,q.x);right=Math.max(right,q.x);bottom=Math.min(bottom,q.y);top=Math.max(top,q.y);
    }
    // Equal UV spans can stretch into long ribbons on a tight fold. Bound the
    // captured diameter in projected sculpture units so these stay small pieces.
    const shrink=Math.min(1,(0.22+Math.sin(piece.phase)*0.025)/Math.max(right-left,top-bottom));
    visible.push({...piece,halfU:piece.halfU*shrink,halfV:piece.halfV*shrink,anchor:point,projected:p,visibility:facing*0.65+(p.z+0.8)*0.20});
  }
  visible.sort((a,b)=>b.visibility-a.visibility||a.index-b.index);
  const selected=[];
  for(const piece of visible) {
    if(selected.some(other=>Math.hypot(piece.projected.x-other.projected.x,piece.projected.y-other.projected.y)<0.13))continue;
    selected.push(piece);if(selected.length===6)break;
  }
  return selected;
}

function sourceHash(values,pieces) {
  let hash=2166136261;
  for(const byte of new Uint8Array(values.buffer,values.byteOffset,values.byteLength))hash=Math.imul(hash^byte,16777619);
  for(const piece of pieces)for(const value of[piece.u,piece.v,piece.halfU,piece.halfV,piece.phase])hash=Math.imul(hash^Math.round(value*1e6),16777619);
  return (hash>>>0).toString(16);
}

// Captures contain only immutable uniforms and UV descriptors. All patches use
// the same small GPU grid, with at most three bursts and eighteen active pieces.
export function createSurfaceFragments(profile,sampleTimeline,uploadSignals,drawSculpture) {
  const snapshots=new Map(),schedule=profile.ghosts?.events??[];
  let captureCount=0;
  const orderedCaptures=()=>[...snapshots.values()].sort((a,b)=>a.event.captureTime-b.event.captureTime||a.event.id-b.event.id);
  function update(time) {
    const events=surfaceFragmentEventsAt(schedule,time),active=new Set(events.map(event=>event.id));
    for(const id of snapshots.keys())if(!active.has(id))snapshots.delete(id);
    for(const event of events) {
      if(snapshots.has(event.id))continue;
      const values=new Float32Array(profile.stride);sampleTimeline(event.captureTime,values);
      const pieces=selectVisibleFragments(values,event,profile.seed??'visu-fragments');
      snapshots.set(event.id,{event,values,pieces,hash:sourceHash(values,pieces)});captureCount++;
    }
  }
  function tears(time) {
    const holes=[];
    for(const {event,pieces}of orderedCaptures())for(const piece of pieces) {
      const pose=surfaceFragmentPose(event,piece,time);
      if(!pose||pose.tear<=0)continue;
      holes.push({bounds:[piece.u,piece.v,piece.halfU,piece.halfV],seed:piece.phase,strength:pose.tear});
    }
    return holes.slice(0,6);
  }
  function draw(time,width,height) {
    const queue=[];
    for(const {event,values,pieces}of orderedCaptures())for(const piece of pieces) {
        const pose=surfaceFragmentPose(event,piece,time);
        if(!pose||pose.opacity<=0.001)continue;
        queue.push({values,piece,pose,depth:piece.anchor[2]+pose.z*(3.8-piece.anchor[2])});
    }
    queue.sort((a,b)=>a.depth-b.depth||a.piece.id.localeCompare(b.piece.id));
    let previous;
    for(const {values,piece,pose}of queue) {
        if(values!==previous){uploadSignals(values);previous=values;}
        drawSculpture(values,width,height,0,{fragment:{
          bounds:[piece.u,piece.v,piece.halfU,piece.halfV],
          motion:[pose.x,pose.y,pose.scale,pose.opacity],
          angles:[pose.tiltX,pose.tiltY,pose.rotation],seed:piece.phase,blur:pose.blur,depth:pose.z,
        }});
    }
  }
  return {update,tears,draw,inspect(time){return{
    captureCount,cached:snapshots.size,tearCount:tears(time).length,
    snapshots:orderedCaptures().map(({event,pieces,hash})=>({id:event.id,captureTime:event.captureTime,sourceHash:hash,pieces:pieces.map(piece=>({id:piece.id,u:piece.u,v:piece.v,visibility:piece.visibility,...surfaceFragmentPose(event,piece,time)}))})),
  };}};
}
