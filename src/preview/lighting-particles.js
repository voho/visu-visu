import { previewCamera } from '/lighting-camera.js';

// Persistent seeded particles travel slowly toward the viewer on four separate
// inertial clocks. Their depth wraps only while fully transparent.
export function createDepthParticles(gl) {
  const vertexSource=`
precision highp float;
attribute vec4 aSeed;
attribute float aLayer;
uniform vec2 uResolution;
uniform vec4 uCamera;
uniform vec4 uDynamics[3];
uniform float uFront;
varying float vAlpha;
varying float vDepth;
varying float vPhase;
varying float vAngle;
void main() {
  float clock=uDynamics[0].y,energy=uDynamics[0].x,rate=0.035;
  if(aLayer>0.5){clock=uDynamics[1].y;energy=uDynamics[1].x;rate=0.016;}
  if(aLayer>1.5){clock=uDynamics[1].w;energy=uDynamics[1].z;rate=0.0055;}
  if(aLayer>2.5){clock=uDynamics[2].y;energy=uDynamics[2].x;rate=0.0016;}
  float depth=fract(aSeed.x+clock*rate*(0.7+aSeed.w*0.6));
  float perspective=0.42+pow(depth,1.7)*1.30;
  float angle=aSeed.y*6.28318530718+clock*rate*(aSeed.w-0.5)*3.2;
  float radius=0.22+aSeed.z*0.76;
  vec2 p=vec2(cos(angle),sin(angle))*radius*perspective;
  p.x*=1.25;
  p+=vec2(sin(angle*2.0+clock*rate),cos(angle*3.0-clock*rate))*0.035;
  p=mat2(cos(uCamera.z),sin(uCamera.z),-sin(uCamera.z),cos(uCamera.z))*p;
  vec2 pixel=uCamera.xy*uResolution+p*min(uResolution.x,uResolution.y);
  gl_Position=vec4(pixel/uResolution*2.0-1.0,0.0,1.0);
  float nearBlur=pow(depth,3.0)*(aLayer<1.5?1.0:0.42);
  gl_PointSize=min(84.0,(2.2+nearBlur*(64.0+energy*20.0)+aSeed.z*3.0)*min(uResolution.x,uResolution.y)/900.0);
  float gate=smoothstep(0.0,0.12,depth)*(1.0-smoothstep(0.79,1.0,depth));
  float frontWeight=smoothstep(0.58,0.78,depth);
  gate*=uFront>0.5?frontWeight:1.0-frontWeight;
  vAlpha=gate*(0.23+energy*0.31)*(0.65+aSeed.z*0.35)*(1.0+nearBlur*0.14);
  vDepth=nearBlur;vPhase=fract(aSeed.y+clock*rate*0.16+energy*0.12);vAngle=angle;
}`;
  const fragmentSource=`
precision highp float;
uniform sampler2D uPalette;
uniform vec2 uResolution;
varying float vAlpha;
varying float vDepth;
varying float vPhase;
varying float vAngle;
void main() {
  vec2 p=gl_PointCoord*2.0-1.0;
  p=mat2(cos(vAngle),sin(vAngle),-sin(vAngle),cos(vAngle))*p;
  float r=length(p);
  float core=exp(-dot(p,p)*(vDepth>0.12?5.0:12.0));
  float bokeh=exp(-pow(r-0.55,2.0)*65.0)*vDepth*0.28;
  float streak=exp(-p.y*p.y*80.0-p.x*p.x*4.0)*(1.0-vDepth)*0.23;
  float edge=1.0-smoothstep(0.76,1.0,r);
  float credits=smoothstep(0.29,0.48,gl_FragCoord.y/uResolution.y);
  vec3 color=texture2D(uPalette,vec2(vPhase,0.5)).rgb;
  color=mix(color,vec3(1.0),0.32);
  float alpha=(core+bokeh+streak)*vAlpha*edge*credits;
  gl_FragColor=vec4(color*alpha,alpha);
}`;
  const program=gl.createProgram();
  for(const [type,source]of[[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]]) {
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`Depth particle shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Depth particle program: ${gl.getProgramInfoLog(program)}`);
  let seed=0x613d2c71;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const data=new Float32Array(160*5);
  for(let index=0;index<160;index++){for(let channel=0;channel<4;channel++)data[index*5+channel]=random();data[index*5+4]=index%4;}
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
  const aSeed=gl.getAttribLocation(program,'aSeed'),aLayer=gl.getAttribLocation(program,'aLayer');
  const resolution=gl.getUniformLocation(program,'uResolution'),cameraUniform=gl.getUniformLocation(program,'uCamera');
  const dynamics=gl.getUniformLocation(program,'uDynamics[0]'),frontUniform=gl.getUniformLocation(program,'uFront');
  gl.useProgram(program);gl.uniform1i(gl.getUniformLocation(program,'uPalette'),7);
  return (values,width,height,front)=>{
    const camera=previewCamera(values,width,height);
    gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.enableVertexAttribArray(aSeed);gl.vertexAttribPointer(aSeed,4,gl.FLOAT,false,20,0);
    gl.enableVertexAttribArray(aLayer);gl.vertexAttribPointer(aLayer,1,gl.FLOAT,false,20,16);
    gl.uniform2f(resolution,width,height);gl.uniform4f(cameraUniform,camera.x,camera.y,camera.roll,camera.zoom);
    gl.uniform4fv(dynamics,values.subarray(135,147));gl.uniform1f(frontUniform,front?1:0);
    gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
    gl.drawArrays(gl.POINTS,0,160);gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(aSeed);gl.disableVertexAttribArray(aLayer);
  };
}
