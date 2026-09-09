const RATE=10;
const DELAYS=[0.35,0.70,1.15];
const WEIGHTS=[0.50,0.32,0.18];

/** Past-only sample brackets, identical regardless of playback or seek order. */
export function lensingSamples(time) {
  const now=Number.isFinite(time)?Math.max(0,time):0;
  const latest=Math.floor(now*RATE);
  return DELAYS.map((delay,index)=>{
    const position=Math.max(0,now-delay)*RATE;
    const a=Math.floor(position),b=Math.min(latest,a+1);
    return {a,b,blend:a===b?0:position-a,weight:WEIGHTS[index]};
  });
}

// Actual projected sculpture silhouettes become a broad, gently delayed lens.
// A16-slot atlas retains recent10Hz poses; one small blend pass combines six
// historical brackets before the fullscreen cover needs just four field taps.
export function createSculptureLensing(gl,capture) {
  const framebuffer=gl.createFramebuffer();
  const atlas=gl.createTexture(),scratchA=gl.createTexture(),scratchB=gl.createTexture(),field=gl.createTexture();
  const vertexSource='attribute vec2 aPosition; varying vec2 vUv; void main(){vUv=aPosition*0.5+0.5;gl_Position=vec4(aPosition,0.0,1.0);}';
  function program(fragmentSource) {
    const program=gl.createProgram();
    for(const [type,source]of[[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]]) {
      const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
      if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`Cover lens shader: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program,shader);gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Cover lens program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }
  const blur=program(`
precision highp float;
uniform sampler2D uSource;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  float total=0.0,density=0.0;
  for(int i=0;i<13;i++) {
    float offset=float(i)-6.0;
    float weight=exp(-offset*offset/8.0);
    density+=dot(texture2D(uSource,clamp(vUv+uStep*offset,0.0,1.0)).rgb,vec3(0.2126,0.7152,0.0722))*weight;
    total+=weight;
  }
  gl_FragColor=vec4(vec3(density/total),1.0);
}`);
  const combine=program(`
precision highp float;
uniform sampler2D uSource;
uniform vec2 uSize;
uniform vec4 uSlots[3];
varying vec2 vUv;
float sampleSlot(float slot) {
  vec2 inside=clamp(vUv,0.5/uSize,1.0-0.5/uSize);
  vec2 cell=vec2(mod(slot,4.0),floor(slot/4.0));
  return texture2D(uSource,(cell+inside)/4.0).r;
}
void main() {
  float density=0.0;
  for(int i=0;i<3;i++)density+=mix(sampleSlot(uSlots[i].x),sampleSlot(uSlots[i].y),uSlots[i].z)*uSlots[i].w;
  gl_FragColor=vec4(vec3(density),1.0);
}`);
  const vertices=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const blurAttribute=gl.getAttribLocation(blur,'aPosition'),combineAttribute=gl.getAttribLocation(combine,'aPosition');
  const blurStep=gl.getUniformLocation(blur,'uStep'),combineSize=gl.getUniformLocation(combine,'uSize');
  const combineSlots=gl.getUniformLocation(combine,'uSlots[0]');
  for(const p of[blur,combine]){gl.useProgram(p);gl.uniform1i(gl.getUniformLocation(p,'uSource'),6);}
  let width=0,height=0,captureCount=0;
  const ids=new Array(16).fill(-1),slots=new Float32Array(12);
  function allocate(texture,w,h) {
    gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  }
  function target(texture) {
    gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    gl.viewport(0,0,width,height);
  }
  function fullscreen(p,attribute,source) {
    gl.useProgram(p);gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
    gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,source);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);
  }
  function ensure(id) {
    const slot=id%16;
    if(ids[slot]===id)return slot;
    target(scratchA);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    capture(id/RATE,width,height);
    target(scratchB);fullscreen(blur,blurAttribute,scratchA);
    gl.uniform2f(blurStep,Math.min(width,height)*0.035/width,0);gl.drawArrays(gl.TRIANGLES,0,3);
    target(scratchA);fullscreen(blur,blurAttribute,scratchB);
    gl.uniform2f(blurStep,0,Math.min(width,height)*0.035/height);gl.drawArrays(gl.TRIANGLES,0,3);
    gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,atlas);
    gl.copyTexSubImage2D(gl.TEXTURE_2D,0,(slot%4)*width,Math.floor(slot/4)*height,0,0,width,height);
    ids[slot]=id;captureCount++;
    return slot;
  }
  return {
    update(time,fullWidth,fullHeight) {
      const ratio=Math.min(0.25,192/Math.max(fullWidth,fullHeight));
      const nextWidth=Math.max(8,Math.round(fullWidth*ratio)),nextHeight=Math.max(8,Math.round(fullHeight*ratio));
      if(nextWidth!==width||nextHeight!==height) {
        width=nextWidth;height=nextHeight;ids.fill(-1);
        allocate(atlas,width*4,height*4);
        for(const texture of[scratchA,scratchB,field])allocate(texture,width,height);
        target(field);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Could not allocate cover lens field');
      }
      // Capture current geometry ahead of its delayed use during normal play.
      ensure(Math.floor(Math.max(0,time)*RATE));
      lensingSamples(time).forEach((sample,index)=>slots.set([ensure(sample.a),ensure(sample.b),sample.blend,sample.weight],index*4));
      target(field);fullscreen(combine,combineAttribute,atlas);
      gl.uniform2f(combineSize,width,height);gl.uniform4fv(combineSlots,slots);gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,fullWidth,fullHeight);
    },
    bind() {gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,field);},
    inspect() {return {width,height,captureCount,cached:ids.filter(id=>id>=0).length};},
    // Explicit QA only; animation never reads the field back from the GPU.
    pixelStats() {
      if(!width||!height)return null;
      const viewport=gl.getParameter(gl.VIEWPORT),pixels=new Uint8Array(width*height*4);
      target(field);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(...viewport);
      let hash=2166136261,maximum=0,nonzero=0;
      for(const byte of pixels)hash=Math.imul(hash^byte,16777619);
      for(let index=0;index<pixels.length;index+=4){maximum=Math.max(maximum,pixels[index]);if(pixels[index]>0)nonzero++;}
      return{hash:(hash>>>0).toString(16),maximum,nonzero};
    },
  };
}
