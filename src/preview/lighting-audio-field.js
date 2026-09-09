import { audioFieldGeometry } from '/audio-field-geometry.js';

// The same RMS envelopes, bass-weighted spectral crown, and signed waveform
// geometry as the MP4 scene, rendered as bounded antialiased GPU line quads.
export function createAudioField(gl, palette, lowFlash = false) {
  const vertexSource = `
attribute vec2 aPosition;
attribute vec4 aColor;
attribute float aEdge;
uniform vec2 uResolution;
varying vec4 vColor;
varying float vEdge;
void main() {
  gl_Position=vec4(aPosition/uResolution*2.0-1.0,0.0,1.0);
  vColor=aColor;vEdge=aEdge;
}`;
  const fragmentSource = `
precision highp float;
uniform vec2 uResolution;
varying vec4 vColor;
varying float vEdge;
void main() {
  float core=exp(-vEdge*vEdge*15.0);
  float glow=exp(-vEdge*vEdge*2.5)*0.16;
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
  const attributes=['aPosition','aColor','aEdge'].map(name=>gl.getAttribLocation(program,name));
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
      const scaleX=Math.min(width*0.43,size*0.53),scaleY=size*(portrait?0.39:0.31);
      const centerX=width*(0.5+Math.sin(values[136]*0.17)*values[135]*0.005);
      const centerY=height*((portrait?0.59:0.635)+Math.cos(values[136]*0.13)*values[135]*0.005);
      const baseWidth=Math.max(0.85,size*0.00115);
      const field=audioFieldGeometry(values.subarray(149,181),values.subarray(68,100),values[147],values[148],values[136]);
      function line(x1,y1,x2,y2,front,color,alpha,lineWidth) {
        const layer=layers[front?1:0];
        x1=centerX+x1*scaleX;x2=centerX+x2*scaleX;
        y1=centerY-y1*scaleY;y2=centerY-y2*scaleY;
        const dx=x2-x1,dy=y2-y1,length=Math.hypot(dx,dy);
        if(length<1e-5)return;
        const nx=-dy/length*lineWidth*2.1,ny=dx/length*lineWidth*2.1;
        for(const [x,y,side] of [[x1,y1,-1],[x2,y2,-1],[x1,y1,1],[x1,y1,1],[x2,y2,-1],[x2,y2,1]]) {
          layer.data[layer.length++]=x+nx*side;
          layer.data[layer.length++]=y+ny*side;
          layer.data.set(color,layer.length);layer.length+=3;
          layer.data[layer.length++]=alpha;
          layer.data[layer.length++]=side;
        }
      }
      function path(points,color,alpha,lineWidth) {
        for(let index=1;index<points.length;index++) {
          const a=points[index-1],b=points[index];
          if(a.front===b.front)line(a.x,a.y,b.x,b.y,a.front,color,alpha*(a.front?1:0.7),lineWidth);
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
      gl.vertexAttribPointer(attributes[0],2,gl.FLOAT,false,28,0);
      gl.vertexAttribPointer(attributes[1],4,gl.FLOAT,false,28,8);
      gl.vertexAttribPointer(attributes[2],1,gl.FLOAT,false,28,24);
      gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
      gl.drawArrays(gl.TRIANGLES,0,layer.length/7);
      gl.disable(gl.BLEND);
      for(const attribute of attributes)gl.disableVertexAttribArray(attribute);
    },
  };
}
