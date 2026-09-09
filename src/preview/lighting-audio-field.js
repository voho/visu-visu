import { audioFieldGeometry } from '/audio-field-geometry.js';
import { previewCamera } from '/lighting-camera.js';

// The same RMS envelopes, bass-weighted spectral crown, and signed waveform
// geometry as the MP4 scene, rendered as bounded antialiased GPU line quads.
export function createAudioField(gl, palette, lowFlash = false) {
  const vertexSource = `
attribute vec2 aPosition;
attribute vec4 aColor;
attribute vec2 aLocal;
attribute vec2 aMetrics;
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vLocal;
varying vec2 vMetrics;
void main() {
  gl_Position=vec4(aPosition/uResolution*2.0-1.0,0.0,1.0);
  vColor=aColor;vLocal=aLocal;vMetrics=aMetrics;
}`;
  const fragmentSource = `
precision highp float;
uniform vec2 uResolution;
varying vec4 vColor;
varying vec2 vLocal;
varying vec2 vMetrics;
void main() {
  // Joined paths share ribbon edges, avoiding bright dots from overlapping
  // segments; standalone stems and the path's outer end caps use capsules.
  float distance=vMetrics.x<0.0?abs(vLocal.y):length(vec2(vLocal.x-clamp(vLocal.x,0.0,vMetrics.x),vLocal.y));
  float halfWidth=vMetrics.y*0.5;
  float core=1.0-smoothstep(max(0.0,halfWidth-0.5),halfWidth+0.5,distance);
  float glow=exp(-distance*distance/(vMetrics.y*vMetrics.y*2.0))*0.14;
  float credits=smoothstep(0.30,0.44,gl_FragCoord.y/uResolution.y);
  float amount=(core+glow)*vColor.a*credits;
  gl_FragColor=vec4(vColor.rgb*amount,amount);
}`;
  function shader(type, source) {
    const object=gl.createShader(type);gl.shaderSource(object,source);gl.compileShader(object);
    if(!gl.getShaderParameter(object,gl.COMPILE_STATUS))throw new Error(`Audio field shader: ${gl.getShaderInfoLog(object)}`);
    return object;
  }
  const program=gl.createProgram();
  const vertex=shader(gl.VERTEX_SHADER,vertexSource),fragment=shader(gl.FRAGMENT_SHADER,fragmentSource);
  gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Audio field program: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  const attributes=['aPosition','aColor','aLocal','aMetrics'].map(name=>gl.getAttribLocation(program,name));
  const resolution=gl.getUniformLocation(program,'uResolution');
  const layers=[false,true].map(()=>({buffer:gl.createBuffer(),data:new Float32Array(64*1024),length:0}));
  let width=1,height=1;
  function colorAt(phase,saturation,lightness) {
    const position=((phase/360%1)+1)%1*palette.colors.length;
    const index=Math.floor(position),blend=position-index;
    const a=palette.colors[index],b=palette.colors[(index+1)%palette.colors.length];
    const color=a.map((value,channel)=>value+(b[channel]-value)*blend);
    const luma=color[0]*0.2126+color[1]*0.7152+color[2]*0.0722;
    return color.map(value=>{
      value=luma+(value-luma)*saturation/100;
      return value+(1-value)*(lightness-50)/50;
    });
  }
  return {
    update(values, nextWidth, nextHeight) {
      width=nextWidth;height=nextHeight;
      for(const layer of layers)layer.length=0;
      const size=Math.min(width,height),portrait=width<height;
      const camera=previewCamera(values,width,height);
      // The landscape sculpture camera is a quarter turn wider; exchange the
      // orbit axes so its surrounding spectral field remains a horizontal ring.
      const scaleX=(portrait?Math.min(width*0.43,size*0.53):size*0.31)*camera.zoom;
      const scaleY=(portrait?size*0.39:Math.min(width*0.43,size*0.53))*camera.zoom;
      const centerX=width*camera.x,centerY=height*camera.y;
      const cosine=Math.cos(camera.roll),sine=Math.sin(camera.roll);
      const baseWidth=Math.max(1.2,size*0.0023);
      const field=audioFieldGeometry(values.subarray(149,181),values.subarray(68,100),values[147],values[148],values[136]);
      function emit(layer,x,y,color,alpha,localX,localY,length,lineWidth) {
        layer.data[layer.length++]=x;layer.data[layer.length++]=y;
        layer.data.set(color,layer.length);layer.length+=3;
        layer.data[layer.length++]=alpha;
        layer.data[layer.length++]=localX;layer.data[layer.length++]=localY;
        layer.data[layer.length++]=length;layer.data[layer.length++]=lineWidth;
      }
      function project(point) {
        const x=point.x*scaleX,y=-point.y*scaleY;
        return [centerX+x*cosine-y*sine,centerY+x*sine+y*cosine];
      }
      function line(x1,y1,x2,y2,front,color,alpha,lineWidth) {
        const layer=layers[front?1:0];
        const ax=x1*scaleX,ay=-y1*scaleY,bx=x2*scaleX,by=-y2*scaleY;
        x1=centerX+ax*cosine-ay*sine;x2=centerX+bx*cosine-by*sine;
        y1=centerY+ax*sine+ay*cosine;y2=centerY+bx*sine+by*cosine;
        const dx=x2-x1,dy=y2-y1,length=Math.hypot(dx,dy);
        if(length<1e-5)return;
        const radius=lineWidth*2.6+1;
        const tx=dx/length,ty=dy/length,nx=-ty,ny=tx;
        for(const [along,side] of [[-radius,-1],[length+radius,-1],[-radius,1],[-radius,1],[length+radius,-1],[length+radius,1]]) {
          emit(layer,x1+tx*along+nx*side*radius,y1+ty*along+ny*side*radius,color,alpha,along,side*radius,length,lineWidth);
        }
      }
      function path(points,color,alpha,lineWidth) {
        const radius=lineWidth*2.6+1;
        for(let start=0;start<points.length;) {
          let end=start+1;
          while(end<points.length&&points[end].front===points[start].front)end++;
          if(end-start<2){start=end;continue;}
          const front=points[start].front,layer=layers[front?1:0],opacity=alpha*(front?1:0.7);
          const positions=points.slice(start,end).map(project);
          const directions=positions.slice(1).map((point,index)=>{
            const dx=point[0]-positions[index][0],dy=point[1]-positions[index][1],length=Math.hypot(dx,dy)||1;
            return [dx/length,dy/length];
          });
          const offsets=positions.map((_,index)=>{
            const previous=directions[Math.max(0,index-1)],next=directions[Math.min(directions.length-1,index)];
            let nx=-previous[1]-next[1],ny=previous[0]+next[0];
            const length=Math.hypot(nx,ny)||1;nx/=length;ny/=length;
            const scale=Math.min(radius*2.5,radius/Math.max(0.4,nx*-next[1]+ny*next[0]));
            return [nx*scale,ny*scale];
          });
          for(let index=1;index<positions.length;index++) {
            for(const [at,side]of[[index-1,-1],[index,-1],[index-1,1],[index-1,1],[index,-1],[index,1]]) {
              emit(layer,positions[at][0]+offsets[at][0]*side,positions[at][1]+offsets[at][1]*side,color,opacity,0,radius*side,-1,lineWidth);
            }
          }
          // Only the outward semicircle is added, so its alpha never doubles
          // over the connected strip and the cap remains uniformly smooth.
          for(const endpoint of[0,positions.length-1]) {
            const direction=directions[endpoint===0?0:directions.length-1],point=positions[endpoint];
            const low=endpoint===0?-radius:0,high=endpoint===0?0:radius;
            for(const [along,side]of[[low,-1],[high,-1],[low,1],[low,1],[high,-1],[high,1]]) {
              emit(layer,point[0]+direction[0]*along-direction[1]*side*radius,
                point[1]+direction[1]*along+direction[0]*side*radius,color,opacity,along,side*radius,0,lineWidth);
            }
          }
          start=end;
        }
      }
      for(const halo of field.halos)path(halo.points,colorAt(halo.phase,88,76),halo.alpha,baseWidth*halo.width);
      for(const spoke of field.spokes)line(spoke.x1,spoke.y1,spoke.x2,spoke.y2,spoke.front,colorAt(spoke.phase,100,79),
        (0.12+spoke.energy*(lowFlash?0.30:0.46))*(spoke.front?1:0.72),baseWidth*(0.85+spoke.energy*0.7));
      path(field.wave,colorAt(65,80,84),field.waveAlpha*(lowFlash?0.78:1),baseWidth*1.2);
      for(const layer of layers) {
        gl.bindBuffer(gl.ARRAY_BUFFER,layer.buffer);
        gl.bufferData(gl.ARRAY_BUFFER,layer.data.subarray(0,layer.length),gl.DYNAMIC_DRAW);
      }
    },
    draw(front) {
      const layer=layers[front?1:0];
      if(!layer.length)return;
      gl.useProgram(program);gl.uniform2f(resolution,width,height);
      gl.bindBuffer(gl.ARRAY_BUFFER,layer.buffer);
      for(const attribute of attributes)gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(attributes[0],2,gl.FLOAT,false,40,0);
      gl.vertexAttribPointer(attributes[1],4,gl.FLOAT,false,40,8);
      gl.vertexAttribPointer(attributes[2],2,gl.FLOAT,false,40,24);
      gl.vertexAttribPointer(attributes[3],2,gl.FLOAT,false,40,32);
      gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
      gl.drawArrays(gl.TRIANGLES,0,layer.length/10);
      gl.disable(gl.BLEND);
      for(const attribute of attributes)gl.disableVertexAttribArray(attribute);
    },
  };
}
