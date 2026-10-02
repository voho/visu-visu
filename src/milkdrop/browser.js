import butterchurnModule from 'butterchurn';
import { MILKDROP_PRESETS, milkdropPreset } from './presets.js';

const butterchurn=butterchurnModule.default??butterchurnModule;
let job,visualizer,gl,canvas,pcm,compose,rawPixels,topDownPixels;
let simulationIndex=0,running=false;
let stats={ready:false,complete:false,frames:0,simulationFrames:0,preset:null,presetName:null,clock:0,renderMs:0,postMs:0};
function assertGpu(stage) {
  const code=gl.getError();
  if(code!==gl.NO_ERROR)throw new Error(`MilkDrop GPU ${stage}: 0x${code.toString(16)} at simulation frame ${simulationIndex}`);
}

function seededRandom(seed) {
  let state=2166136261;
  for(const character of String(seed))state=Math.imul(state^character.charCodeAt(0),16777619);
  return ()=>{
    state=(state+0x6D2B79F5)>>>0;
    let value=state;
    value=Math.imul(value^value>>>15,value|1);
    value^=value+Math.imul(value^value>>>7,value|61);
    return ((value^value>>>14)>>>0)/4294967296;
  };
}

async function resource(path) {
  const response=await fetch(job.base+path);
  if(!response.ok)throw new Error(`MilkDrop asset ${path}: HTTP ${response.status}`);
  return response;
}
async function image(path) {
  return createImageBitmap(await (await resource(path)).blob(),{premultiplyAlpha:'none',colorSpaceConversion:'none'});
}

function createCompositor(cover) {
  const shader=(type,source)=>{
    const object=gl.createShader(type);gl.shaderSource(object,source);gl.compileShader(object);
    if(!gl.getShaderParameter(object,gl.COMPILE_STATUS))throw new Error(`MilkDrop compositor shader: ${gl.getShaderInfoLog(object)}`);
    return object;
  };
  const vertex=shader(gl.VERTEX_SHADER,`#version 300 es
  in vec2 aPosition;
  out vec2 vUv;
  void main(){gl_Position=vec4(aPosition,0.0,1.0);vUv=aPosition*0.5+0.5;}`);
  const fragment=shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;
  uniform sampler2D uScene,uPalette,uCover;
  uniform vec2 uResolution;
  uniform vec4 uCredit,uHero;
  uniform vec4 uMusic;
  uniform float uTime,uArtwork,uLowFlash,uIntensity;
  in vec2 vUv;
  out vec4 outputColor;
  float hue(vec3 color){
    vec4 k=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);
    vec4 p=mix(vec4(color.bg,k.wz),vec4(color.gb,k.xy),step(color.b,color.g));
    vec4 q=mix(vec4(p.xyw,color.r),vec4(color.r,p.yzx),step(p.x,color.r));
    float delta=q.x-min(q.w,q.y);
    return abs(q.z+(q.w-q.y)/(6.0*delta+0.000001));
  }
  void main(){
    vec3 source=max(texture(uScene,vUv).rgb,vec3(0.0));
    float signal=max(source.r,max(source.g,source.b));
    float light=1.0-exp(-signal*(1.5+uIntensity*0.45));
    float phase=fract(hue(source)+signal*0.09+uTime*0.007+uMusic.y*0.04);
    vec3 swatch=texture(uPalette,vec2(phase,0.5)).rgb;
    // All pigment comes from the shared scene palette. Use its own luminance
    // to soften saturation without rotating hues or tinting neutral covers.
    vec3 chroma=swatch/max(0.20,max(swatch.r,max(swatch.g,swatch.b)));
    float luminance=dot(chroma,vec3(0.2126,0.7152,0.0722));
    chroma=mix(vec3(luminance),chroma,0.68);
    vec3 flow=chroma*light*(1.0-uLowFlash*0.18)*clamp(uIntensity,0.0,2.0);
    // Translucent light over the cover (or dark room), keeping the foreground
    // sculpture and readouts brighter. Do not normalize away this attenuation.
    flow*=0.48;
    vec2 screen=vec2(vUv.x,1.0-vUv.y);
    vec2 creditDistance=(screen-uCredit.xy)/max(uCredit.zw,vec2(0.02));
    float shade=exp(-dot(creditDistance,creditDistance)*1.4);
    flow*=1.0-shade*0.78;
    vec2 heroDistance=(screen-uHero.xy)/max(uHero.zw,vec2(0.02));
    float heroShade=exp(-dot(heroDistance,heroDistance)*1.25);
    flow*=1.0-0.60*heroShade;
    vec2 coverUv=(vUv-0.5)/(1.015+uMusic.x*0.014+uMusic.w*0.009)+0.5;
    vec4 coverSample=texture(uCover,coverUv);
    // The prepared photograph carries its vignette and credit/hero protection
    // in alpha. Respect it when compositing over black, as the Canvas path does.
    vec3 backdrop=coverSample.rgb*coverSample.a*uArtwork*(0.95-shade*0.25);
    vec3 color=1.0-(1.0-backdrop)*(1.0-flow);
    float vignette=1.0-smoothstep(0.30,0.78,length((vUv-0.5)*vec2(1.0,0.94)));
    color*=0.73+vignette*0.27;
    // Bright photographs and broad feedback fog share one exposure budget.
    // Leave shadows untouched; roll highlights off gently with a single RGB
    // scale, retaining hue/neutrality and reserving brighter light for the hero.
    float budget=0.70+uMusic.x*0.018-heroShade*0.06-shade*0.10-uLowFlash*0.015;
    float peak=max(color.r,max(color.g,color.b)),knee=budget*0.60;
    if(peak>knee){
      float range=budget-knee;
      float compressed=knee+range*(1.0-exp(-(peak-knee)/range));
      color*=compressed/peak;
    }
    outputColor=vec4(color,1.0);
  }`);
  const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`MilkDrop compositor: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vertex);gl.deleteShader(fragment);
  const vao=gl.createVertexArray();gl.bindVertexArray(vao);
  const vertices=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vertices);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const position=gl.getAttribLocation(program,'aPosition');gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);gl.bindVertexArray(null);
  const textures=[];
  function texture(unit,width,height,data) {
    const texture=gl.createTexture();gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,texture);
    const format=unit===0?gl.RGB:gl.RGBA;
    if(data&&!(data instanceof Uint8Array))gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,data);
    else gl.texImage2D(gl.TEXTURE_2D,0,format,width,height,0,format,gl.UNSIGNED_BYTE,data);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    textures.push(texture);
  }
  texture(0,job.width,job.height,null);
  const palette=new Uint8Array(256*4),colors=job.palette;
  for(let i=0;i<256;i++){
    const p=i/255*colors.length,index=Math.floor(p)%colors.length,t=p-Math.floor(p);
    for(let channel=0;channel<3;channel++)palette[i*4+channel]=Math.round((colors[index][channel]*(1-t)+colors[(index+1)%colors.length][channel]*t)*255);
    palette[i*4+3]=255;
  }
  texture(1,256,1,palette);
  // ImageBitmap orientation is fixed at decode; transform in a temporary 2D
  // canvas since WebGL's UNPACK_FLIP_Y does not apply to ImageBitmap uploads.
  function oriented(bitmap) {
    if(!bitmap)return new Uint8Array([0,0,0,0]);
    const copy=new OffscreenCanvas(bitmap.width,bitmap.height),context=copy.getContext('2d');
    context.translate(0,bitmap.height);context.scale(1,-1);context.drawImage(bitmap,0,0);
    return copy;
  }
  texture(2,cover?.width??1,cover?.height??1,oriented(cover));
  const uniforms=Object.fromEntries(['uScene','uPalette','uCover','uResolution','uCredit','uHero','uMusic','uTime','uArtwork','uLowFlash','uIntensity']
    .map(name=>[name,gl.getUniformLocation(program,name)]));
  return (time,features)=>{
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,textures[0]);
    gl.copyTexSubImage2D(gl.TEXTURE_2D,0,0,0,0,0,job.width,job.height);
    assertGpu('copying the preset framebuffer');
    gl.useProgram(program);gl.bindVertexArray(vao);gl.viewport(0,0,job.width,job.height);
    gl.disable(gl.BLEND);gl.disable(gl.DEPTH_TEST);gl.disable(gl.SCISSOR_TEST);
    for(let i=0;i<textures.length;i++){
      gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,textures[i]);
      gl.bindSampler(i,null);
      gl.uniform1i(uniforms[['uScene','uPalette','uCover'][i]],i);
    }
    gl.uniform2f(uniforms.uResolution,job.width,job.height);
    gl.uniform4f(uniforms.uCredit,job.credit.cx,job.credit.cy,job.credit.rx,job.credit.ry);
    const hero=job.hero??{cx:0.5,cy:0.45,rx:0.45,ry:0.38};
    gl.uniform4f(uniforms.uHero,hero.cx,hero.cy,hero.rx,hero.ry);
    gl.uniform4f(uniforms.uMusic,features[0],features[1],features[2],features[4]);
    gl.uniform1f(uniforms.uTime,time);gl.uniform1f(uniforms.uArtwork,job.hasArtwork?1:0);
    gl.uniform1f(uniforms.uLowFlash,job.lowFlash?1:0);gl.uniform1f(uniforms.uIntensity,job.intensity??1);
    assertGpu('compositor uniforms');
    gl.drawArrays(gl.TRIANGLES,0,3);gl.bindVertexArray(null);
  };
}

async function init(config) {
  if(stats.ready)throw new Error('A MilkDrop page can initialize only one export job');
  job=config;
  if(job.sampleRate!==44100)throw new Error('Butterchurn 2.6.7 requires 44100 Hz PCM for its offline frequency analysis');
  if(!job.palette?.length)throw new Error('MilkDrop requires a palette');
  if(job.schedule?.length!==1||job.schedule[0].frame!==0||job.schedule[0].blendSeconds!==0)
    throw new Error('MilkDrop requires exactly one preset, loaded at frame zero without a blend');
  const [audio,cover]=await Promise.all([
    resource('/pcm').then(response=>response.arrayBuffer()),job.hasArtwork?image('/cover.png'):null,
  ]);
  pcm=new Float32Array(audio);
  canvas=document.createElement('canvas');canvas.width=job.width;canvas.height=job.height;
  canvas.id='milkdrop-output';canvas.style.cssText='width:100vw;height:100vh;display:block;object-fit:contain;background:black';
  document.body.style.cssText='margin:0;background:black;overflow:hidden';document.body.replaceChildren(canvas);
  // The pinned stable engine predates its newer deterministic option. Its
  // internal noise and rand() use this seeded stream.
  Math.random=seededRandom(job.seed);
  visualizer=butterchurn.createVisualizer(null,canvas,{
    width:job.width,height:job.height,pixelRatio:1,textureRatio:1,
    meshWidth:64,meshHeight:48,outputFXAA:true,
  });
  gl=visualizer.renderer.gl;
  if(!gl)throw new Error('WebGL 2 is unavailable for MilkDrop export');
  assertGpu('initialization');
  canvas.addEventListener('webglcontextlost',()=>{stats.error='MilkDrop GPU context was lost';});
  const renderer=visualizer.renderer;
  renderer.time=job.simulationStart;renderer.fps=job.fps;
  renderer.calcTimeAndFPS=function(){
    this.time=job.simulationStart+simulationIndex/job.fps;this.fps=job.fps;
    if(this.blending){
      this.blendProgress=this.blendDuration>0?(this.time-this.blendStartTime)/this.blendDuration:1;
      if(this.blendProgress>=1)this.blending=false;
    }
  };
  const first=job.schedule[0];
  visualizer.loadPreset(milkdropPreset(first.preset),0);
  assertGpu('preset compilation');
  stats.preset=first.preset;stats.presetName=MILKDROP_PRESETS.find(preset=>preset.id===first.preset).name;
  compose=createCompositor(cover);
  assertGpu('compositor initialization');
  cover?.close();
  rawPixels=new Uint8Array(job.width*job.height*4);topDownPixels=new Uint8Array(rawPixels.length);
  stats={...stats,ready:true,engine:'Butterchurn 2.6.7',width:job.width,height:job.height,fps:job.fps};
}

async function uploadFrame(index,pixels) {
  // The export launcher deliberately leaves Chrome's Network inspector disabled:
  // recording raw frame payloads retains gigabytes even with sequential uploads.
  const response=await fetch(`${job.base}/frame/${index}`,{
    method:'POST',headers:{'Content-Type':'application/octet-stream'},body:pixels,
  });
  if(!response.ok)throw new Error(`MilkDrop frame ${index}: HTTP ${response.status} ${await response.text()}`);
}

async function renderAll() {
  if(!stats.ready)throw new Error('Initialize MilkDrop before rendering');
  if(running||stats.complete)throw new Error('MilkDrop frames must be rendered once, in sequence');
  running=true;
  const audioLevels={timeByteArray:new Uint8Array(1024),timeByteArrayL:new Uint8Array(1024),timeByteArrayR:new Uint8Array(1024)};
  try {
    // Await each upload so the encoder controls backpressure and only one frame
    // plus the reusable readback buffers remain in flight.
    for(simulationIndex=0;simulationIndex<job.simulationFrames;simulationIndex++) {
      if(stats.error||gl.isContextLost())throw new Error(stats.error??'MilkDrop GPU context was lost');
      const begin=performance.now(),time=job.simulationStart+simulationIndex/job.fps;
      visualizer.renderer.time=time;
      const end=Math.floor(simulationIndex*job.sampleRate/job.fps);
      for(let i=0;i<1024;i++){
        const sampleIndex=end-1024+i;
        const left=sampleIndex>=0?(pcm[sampleIndex*2]??0):0,right=sampleIndex>=0?(pcm[sampleIndex*2+1]??0):0;
        const byte=value=>Math.max(0,Math.min(255,Math.round(value*127+128)));
        audioLevels.timeByteArrayL[i]=byte(left);audioLevels.timeByteArrayR[i]=byte(right);
        audioLevels.timeByteArray[i]=byte((left+right)*0.5);
      }
      visualizer.render({elapsedTime:1/job.fps,audioLevels});
      assertGpu('preset rendering');
      stats.clock=time;stats.simulationFrames=simulationIndex+1;
      if(simulationIndex<job.outputStartFrame){stats.renderMs+=performance.now()-begin;continue;}
      compose(time,job.features[simulationIndex]??[0,0,0,0,0]);
      assertGpu('compositing');
      gl.readPixels(0,0,job.width,job.height,gl.RGBA,gl.UNSIGNED_BYTE,rawPixels);
      assertGpu('readback');
      const rowBytes=job.width*4;
      for(let row=0;row<job.height;row++)topDownPixels.set(rawPixels.subarray(row*rowBytes,(row+1)*rowBytes),(job.height-1-row)*rowBytes);
      stats.renderMs+=performance.now()-begin;
      const posted=performance.now(),index=simulationIndex-job.outputStartFrame;
      await uploadFrame(index,topDownPixels);
      stats.postMs+=performance.now()-posted;stats.frames=index+1;
    }
    if(stats.frames!==job.totalFrames)throw new Error(`MilkDrop emitted ${stats.frames} frames; expected ${job.totalFrames}`);
    stats.complete=true;
  } finally {running=false;}
}

window.milkdrop={init,renderAll,inspect:()=>({...stats})};
