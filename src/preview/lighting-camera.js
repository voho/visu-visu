// One deterministic camera registers the live mesh, audio field, glow, frozen
// captures and delayed lens masks. A preflight silhouette guide reserves space
// before a large fold arrives, so fitting never pumps on individual FFT bins.
const TAU=Math.PI*2;
let guide=[];
let hero={top:0.075,bottom:0.65};
const fitting=new Map();

export function setPreviewHero(width,height,creditTop) {
  hero={top:Math.max(64/height,0.065),bottom:Math.min(0.72,(creditTop||height*0.70)/height-0.025)};
  fitting.clear();
}

export function createSculptureSampler(values) {
  const slow=values[0],fast=values[1],bass=values[139],mids=values[141],treble=values[143],pulse=values[145];
  const drift=slow*0.46+0.8,morph=slow*1.8;
  const orb=0.5+Math.sin(morph*0.54+2)*0.5,flower=0.5+Math.sin(morph*0.67+0.8)*0.5,knot=0.5+Math.sin(morph*0.41+1.9)*0.5;
  const ax=0.55+Math.sin(morph*0.34+1.9)*0.78,ay=Math.sin(morph*0.29+0.8)*0.92;
  const az=morph*0.11+Math.sin(morph*0.21+1.9)*0.26+Math.sin(values[136]*0.13)*0.025;
  const ca=Math.cos(ax),sa=Math.sin(ax),cb=Math.cos(ay),sb=Math.sin(ay),cc=Math.cos(az),sc=Math.sin(az);
  const sample=(start,x)=>{
    const q=Math.max(0,Math.min(31,x*32-0.5)),a=Math.floor(q),t=q-a;
    return values[start+a]*(1-t)+values[start+Math.min(31,a+1)]*t;
  };
  return (parameterU,parameterV)=>{
    const u=parameterU*TAU,phase=parameterV*TAU;
    const angle=u+slow*0.12+0.8+Math.sin(u*2+drift*0.4)*knot*0.12;
    const band=0.5-Math.cos(u+Math.sin(phase)*0.18+drift*0.22)*0.5;
    const displacement=sample(36,band)*(1-band*0.86);
    const wave=sample(68,band)*0.5+sample(68,Math.max(0.016,band-0.03125))*0.25+sample(68,Math.min(0.984,band+0.03125))*0.25;
    const flow=phase+u+drift+Math.sin(u+drift*0.7)*(0.52+knot*0.46)+Math.sin(u*3+drift*0.45)*(0.25+mids*0.12);
    const v=flow+Math.sin(flow*2)*(0.26+flower*0.2),lobe=Math.cos(u*3-drift*0.62);
    const major=0.57-orb*0.2+bass*0.045+displacement*0.12+wave*0.015
      +lobe*(0.035+flower*0.065+bass*0.12)*(1-orb*0.4)
      +Math.sin(u*2+drift*0.4)*(0.02+mids*0.025+displacement*0.035)
      +pulse*(0.035+Math.sin(u*3-fast*0.68)*0.12);
    const tube=(0.17+orb*0.18+mids*0.035)*(1+Math.sin(u*2+drift)*(0.18+mids*0.1+bass*0.12))
      +pulse*(0.025+Math.sin(u*2+phase)*0.025)+treble*Math.sin(u*7-fast*1.6+phase)*0.009;
    const distance=major+Math.cos(v)*tube,stretch=Math.sin(drift*0.8)*(0.04+values[137]*0.07+bass*0.055);
    let x=Math.cos(angle)*distance*(1+stretch),y=Math.sin(angle)*distance*(1-stretch);
    let z=Math.sin(v)*tube+Math.sin(u*2+drift*0.6)*(0.025+knot*0.105+bass*0.075)+Math.sin(u*3-fast*0.68)*pulse*0.085;
    [y,z]=[ca*y-sa*z,sa*y+ca*z];
    [x,z]=[cb*x+sb*z,-sb*x+cb*z];
    return [cc*x-sc*y,sc*x+cc*y,z];
  };
}

function bounds(values) {
  const sample=createSculptureSampler(values);
  const roll=Math.sin(values[136]*0.26)*0.062+Math.sin(values[138]*0.13)*values[137]*0.022;
  const c=Math.cos(roll),s=Math.sin(roll);
  let left=Infinity,right=-Infinity,bottom=Infinity,top=-Infinity;
  for(let i=0;i<48;i++)for(let j=0;j<16;j++) {
    const phase=j/16*TAU;
    const p=sample(i/48,j/16+(Math.sin(phase*3+0.8)*0.2+Math.sin(phase*6+1.6)*0.05)/TAU);
    const perspective=3.8/(3.8-p[2]),x=(c*p[0]-s*p[1])*perspective,y=(s*p[0]+c*p[1])*perspective;
    left=Math.min(left,x);right=Math.max(right,x);bottom=Math.min(bottom,y);top=Math.max(top,y);
  }
  return {clock:values[0],left,right,bottom,top,cx:(left+right)/2,cy:(bottom+top)/2};
}

export function preparePreviewCamera(timeline,profile) {
  fitting.clear();
  const poses=[];
  for(let time=0;time<=profile.duration+0.1;time+=0.1) {
    const frame=Math.min(profile.frameCount-1,Math.round(time*profile.fps));
    poses.push({...bounds(timeline.subarray(frame*profile.stride,(frame+1)*profile.stride)),time:frame/profile.fps});
  }
  const smooth=(key,index,radius)=>{
    let total=0,weight=0;
    for(let delta=-radius;delta<=radius;delta++) {
      const w=radius+1-Math.abs(delta);total+=poses[Math.max(0,Math.min(poses.length-1,index+delta))][key]*w;weight+=w;
    }
    return total/weight;
  };
  // Smoothly moving centers plus a surrounding temporal envelope prevent a
  // single energetic fold from forcing abrupt normalization or a clipped tip.
  guide=poses.map((pose,index)=>({...pose,cx:smooth('cx',index,4),cy:smooth('cy',index,4)}));
  for(let i=0;i<guide.length;i++) {
    let rx=0,ry=0;
    for(let delta=-1;delta<=1;delta++) {
      const p=poses[Math.max(0,Math.min(poses.length-1,i+delta))];
      rx=Math.max(rx,Math.abs(p.left-guide[i].cx),Math.abs(p.right-guide[i].cx));
      ry=Math.max(ry,Math.abs(p.bottom-guide[i].cy),Math.abs(p.top-guide[i].cy));
    }
    guide[i].rx=rx*1.06;guide[i].ry=ry*1.06;
  }
}

export function previewCamera(values,width,height) {
  const drift=values[136],cloud=values[138],portrait=width<height;
  const roll=Math.sin(drift*0.26)*0.062+Math.sin(cloud*0.13)*values[137]*0.022+(portrait?0:Math.PI/2);
  let pose={cx:0,cy:0,rx:0.95,ry:0.95};
  let index=0,blend=0;
  if(guide.length) {
    let low=0,high=guide.length-1;
    while(low<high){const mid=(low+high+1)>>1;if(guide[mid].clock<=values[0])low=mid;else high=mid-1;}
    const a=guide[low],b=guide[Math.min(guide.length-1,low+1)],t=Math.max(0,Math.min(1,(values[0]-a.clock)/Math.max(0.00001,b.clock-a.clock)));
    index=low;blend=t;
    for(const key of['cx','cy','rx','ry'])pose[key]=a[key]+(b[key]-a[key])*t;
  }
  if(!portrait)pose={cx:-pose.cy,cy:pose.cx,rx:pose.ry,ry:pose.rx};
  const unit=Math.min(width,height)*(portrait?0.432:0.338);
  const availableY=Math.max(0.18,hero.bottom-hero.top)*height;
  let fit=Math.min(width*0.455/(unit*pose.rx),availableY*0.5/(unit*pose.ry));
  if(guide.length) {
    const key=`${width/height}`;
    if(!fitting.has(key)) {
      const curve=guide.map(p=>Math.min(1.5,width*0.455/(unit*(portrait?p.rx:p.ry)),availableY*0.5/(unit*(portrait?p.ry:p.rx))));
      // An offline forward/backward speed envelope anticipates large folds and
      // releases afterwards. It remains below every fit limit and caps zoom
      // travel at .38 units/second, including between guide samples and seeks.
      for(let i=1;i<curve.length;i++)curve[i]=Math.min(curve[i],curve[i-1]+(guide[i].time-guide[i-1].time)*0.38);
      for(let i=curve.length-2;i>=0;i--)curve[i]=Math.min(curve[i],curve[i+1]+(guide[i+1].time-guide[i].time)*0.38);
      if(fitting.size>=8)fitting.delete(fitting.keys().next().value);
      fitting.set(key,curve);
    }
    const curve=fitting.get(key);
    fit=curve[index]+(curve[Math.min(curve.length-1,index+1)]-curve[index])*blend;
  }
  const requested=1.28+values[139]*0.042+values[145]*0.016+Math.sin(cloud*0.19)*0.011;
  // Smooth minimum avoids a derivative jump when the framing envelope takes
  // over from musical zoom. All dimensions use this same uniform scale.
  const zoom=Math.pow(Math.pow(requested,-16)+Math.pow(fit,-16),-1/16);
  return {
    x:0.5-pose.cx*unit*zoom/width+Math.sin(drift*0.29)*values[135]*0.003,
    y:1-(hero.top+hero.bottom)/2-pose.cy*unit*zoom/height+Math.cos(drift*0.23)*values[135]*0.002,
    roll,zoom,creditFloor:1-hero.bottom,creditCeiling:1-hero.top,
  };
}
