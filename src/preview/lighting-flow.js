import { FLOW_AGES, spectralFlowPaths } from '../render/spectral-flow.js';
import { previewCamera } from './lighting-camera.js';

/** Rebuild a short, absolute-time history on every seek; never retain pixels. */
export function sampleSpectralFlowTimeline(time, profile, sampleTimeline) {
  const samples=[];
  for(const age of FLOW_AGES) {
    if(time<age)continue;
    const at=time-age,values=new Float32Array(profile.stride);
    sampleTimeline(at,values);
    const smooth=(a,b,value)=>{const x=Math.max(0,Math.min(1,(value-a)/(b-a)));return x*x*(3-2*x);};
    const duration=profile.duration;
    const presence=smooth(Math.min(0.4,duration*0.1),Math.min(3.2,duration*0.3),at)
      *(1-0.55*smooth(Math.max(duration-14,duration*0.55),Math.max(duration-3,duration*0.85),at));
    samples.push({age,state:{
      time:at,bass:values[139]*(0.30+0.70*values[2]),mid:values[141]*(0.5+0.5*values[3]),
      treble:values[143]*(0.5+0.5*values[4]),impact:values[145],
      slow:values[136],fast:values[142],energy:values[7],presence,
      spectrum:values.subarray(149,181),waveform:values.subarray(68,100),
    }});
  }
  return samples;
}

/** Joined GPU ribbons keep light intensity even at each polyline vertex. */
export function buildFlowRibbons(paths, colors, frame) {
  const {width,height,creditFloor,creditCeiling}=frame;
  const halfWidth=width*0.49,halfHeight=(creditCeiling-creditFloor)*height*0.5;
  const unit=Math.min(halfWidth,halfHeight),centerX=width*0.5,centerY=(creditFloor+creditCeiling)*height*0.5;
  const stride=10,maxVertices=paths.reduce((total,path)=>total+Math.max(0,path.points.length-1)*6+12,0);
  const vertices=new Float32Array(maxVertices*stride);
  let count=0;
  const emit=(x,y,color,alpha,along,side,cap,lineWidth,blur)=>{
    vertices[count++]=x;vertices[count++]=y;
    for(const channel of color)vertices[count++]=channel;
    vertices[count++]=alpha;
    vertices[count++]=along;vertices[count++]=side;
    // The blur sign distinguishes connected strips from capsule end caps.
    vertices[count++]=cap<0?-blur:blur;vertices[count++]=lineWidth;
  };
  if(!(unit>0)||!colors.length)return vertices.subarray(0,0);
  for(const path of paths) {
    if(path.points.length<2||path.alpha<=0)continue;
    const phase=((path.color%1)+1)%1*colors.length,index=Math.floor(phase),blend=phase-index;
    const a=colors[index],b=colors[(index+1)%colors.length];
    const color=a.map((value,channel)=>Math.max(0,Math.min(1,value+(b[channel]-value)*blend)));
    const lineWidth=Math.max(0.8,path.width*unit),blur=Math.max(0.7,path.blur*unit);
    const radius=lineWidth*0.5+blur*2.6+1;
    const points=path.points.map(point=>[centerX+point.x*halfWidth,centerY-point.y*halfHeight]);
    const closed=Math.hypot(points[0][0]-points.at(-1)[0],points[0][1]-points.at(-1)[1])<0.001;
    const directions=points.slice(1).map((point,i)=>{
      const dx=point[0]-points[i][0],dy=point[1]-points[i][1],length=Math.hypot(dx,dy)||1;
      return [dx/length,dy/length];
    });
    const offsets=points.map((_,i)=>{
      const previous=directions[i===0&&closed?directions.length-1:Math.max(0,i-1)];
      const next=directions[i===points.length-1&&closed?0:Math.min(directions.length-1,i)];
      let nx=-previous[1]-next[1],ny=previous[0]+next[0];
      const length=Math.hypot(nx,ny)||1;nx/=length;ny/=length;
      const scale=Math.min(radius*2,radius/Math.max(0.5,nx*-next[1]+ny*next[0]));
      return [nx*scale,ny*scale];
    });
    const alpha=path.alpha*(frame.lowFlash?0.78:1);
    for(let i=1;i<points.length;i++) {
      for(const [at,side]of[[i-1,-1],[i,-1],[i-1,1],[i-1,1],[i,-1],[i,1]]) {
        emit(points[at][0]+offsets[at][0]*side,points[at][1]+offsets[at][1]*side,
          color,alpha,0,radius*side,-1,lineWidth,blur);
      }
    }
    for(const endpoint of(closed?[]:[0,points.length-1])) {
      const point=points[endpoint],direction=directions[endpoint===0?0:directions.length-1];
      const low=endpoint===0?-radius:0,high=endpoint===0?0:radius;
      for(const [along,side]of[[low,-1],[high,-1],[low,1],[low,1],[high,-1],[high,1]]) {
        emit(point[0]+direction[0]*along-direction[1]*side*radius,
          point[1]+direction[1]*along+direction[0]*side*radius,color,alpha,along,side*radius,0,lineWidth,blur);
      }
    }
  }
  return vertices.subarray(0,count);
}

export function createSpectralFlow(gl,profile,sampleTimeline) {
  const vertexSource=`
attribute vec2 aPosition;
attribute vec4 aColor;
attribute vec2 aLocal;
attribute vec2 aMetrics;
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vLocal;
varying vec2 vMetrics;
void main(){
  gl_Position=vec4(aPosition/uResolution*2.0-1.0,0.0,1.0);
  vColor=aColor;vLocal=aLocal;vMetrics=aMetrics;
}`;
  const fragmentSource=`
precision highp float;
uniform vec2 uResolution;
uniform vec2 uCreditBounds;
varying vec4 vColor;
varying vec2 vLocal;
varying vec2 vMetrics;
void main(){
  float distance=vMetrics.x<0.0?abs(vLocal.y):length(vLocal);
  float blur=abs(vMetrics.x),halfWidth=vMetrics.y*0.5;
  float outer=max(0.0,distance-halfWidth);
  float core=1.0-smoothstep(max(0.0,halfWidth-0.5),halfWidth+0.5,distance);
  float glow=exp(-outer*outer/max(0.5,blur*blur*2.0))*0.22;
  float y=gl_FragCoord.y/uResolution.y;
  float protection=smoothstep(uCreditBounds.x,uCreditBounds.x+0.055,y)
    *(1.0-smoothstep(uCreditBounds.y-0.05,uCreditBounds.y,y));
  float edge=smoothstep(0.0,0.045,gl_FragCoord.x/uResolution.x)
    *smoothstep(0.0,0.045,1.0-gl_FragCoord.x/uResolution.x);
  float amount=min(0.7,(core+glow)*vColor.a)*protection*edge;
  gl_FragColor=vec4(vColor.rgb*amount,amount);
}`;
  const compile=(type,source)=>{
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`Spectral flow shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  };
  const program=gl.createProgram(),vertex=compile(gl.VERTEX_SHADER,vertexSource),fragment=compile(gl.FRAGMENT_SHADER,fragmentSource);
  gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Spectral flow program: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  const attributes=['aPosition','aColor','aLocal','aMetrics'].map(name=>gl.getAttribLocation(program,name));
  const resolution=gl.getUniformLocation(program,'uResolution'),credits=gl.getUniformLocation(program,'uCreditBounds');
  const buffer=gl.createBuffer();
  let stats={paths:0,vertices:0,history:0};
  return {
    draw(time,values,width,height) {
      const samples=sampleSpectralFlowTimeline(time,profile,sampleTimeline);
      const paths=spectralFlowPaths(samples,profile.seed??'visu-spectral-flow');
      const camera=previewCamera(values,width,height);
      const vertices=buildFlowRibbons(paths,profile.palette.colors,{width,height,
        creditFloor:camera.creditFloor,creditCeiling:camera.creditCeiling,lowFlash:profile.lowFlash});
      stats={paths:paths.length,vertices:vertices.length/10,history:samples.length};
      if(!vertices.length)return;
      gl.useProgram(program);gl.uniform2f(resolution,width,height);gl.uniform2f(credits,camera.creditFloor,camera.creditCeiling);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.DYNAMIC_DRAW);
      for(const attribute of attributes)gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attributes[0],2,gl.FLOAT,false,40,0);
      gl.vertexAttribPointer(attributes[1],4,gl.FLOAT,false,40,8);
      gl.vertexAttribPointer(attributes[2],2,gl.FLOAT,false,40,24);
      gl.vertexAttribPointer(attributes[3],2,gl.FLOAT,false,40,32);
      gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
      gl.drawArrays(gl.TRIANGLES,0,vertices.length/10);
      gl.disable(gl.BLEND);
      for(const attribute of attributes)gl.disableVertexAttribArray(attribute);
    },
    inspect(){return {...stats};},
  };
}
