import { createSculpture } from '/lighting-mesh.js';
import { createFrozenHistory } from '/lighting-ghosts.js';
import { createAudioField } from '/lighting-audio-field.js';
import { previewCamera, preparePreviewCamera, setPreviewHero } from '/lighting-camera.js';
import { createSculptureGlow } from '/lighting-glow.js';
import { createDepthParticles } from '/lighting-particles.js';
import { createSculptureLensing } from '/lighting-lensing.js';
import { createSurfaceFragments } from '/lighting-fragments.js';
const canvas = document.querySelector('#scene');
const audio = document.querySelector('#audio');
const play = document.querySelector('#play');
const seek = document.querySelector('#seek');
const status = document.querySelector('#status');
const view = document.querySelector('#view');
const error = document.querySelector('#error');

const vertexSource = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;
const fragmentSource = `
precision highp float;
uniform vec2 uResolution;
uniform float uTime;
uniform vec4 uMotion;
uniform vec4 uDynamics[3];
uniform vec3 uAmbient;
uniform float uExposure;
uniform vec3 uLightPosition[3];
uniform vec3 uLightColor[3];
uniform vec2 uLightPower[3];
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uRoughness;
uniform sampler2D uArtwork;
uniform sampler2D uFeatures;
uniform sampler2D uPalette;
uniform sampler2D uLensing;
uniform float uHasArtwork;
uniform float uArtworkAspect;
uniform float uView;
uniform float uImpactLimit;
const float PI = 3.14159265359;

float hash21(vec2 p) {
  vec3 q=fract(vec3(p.xyx)*0.1031);
  q+=dot(q,q.yzx+33.33);
  return fract((q.x+q.y)*q.z);
}
float noise21(vec2 p) {
  vec2 cell=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash21(cell),hash21(cell+vec2(1.0,0.0)),f.x),
    mix(hash21(cell+vec2(0.0,1.0)),hash21(cell+1.0),f.x),f.y);
}
float cloudNoise(vec2 p) {
  float total=noise21(p)*0.57;
  p=mat2(1.6,1.2,-1.2,1.6)*p+3.1;
  total+=noise21(p)*0.28;
  p=mat2(1.6,1.2,-1.2,1.6)*p+1.7;
  return total+noise21(p)*0.15;
}
mat2 rotation(float angle) {
  return mat2(cos(angle),sin(angle),-sin(angle),cos(angle));
}
vec3 blurredArtwork(vec2 uv,float radius) {
  vec2 blur=vec2(radius/uArtworkAspect,radius);
  return texture2D(uArtwork,uv).rgb*0.36
    +(texture2D(uArtwork,uv+vec2(blur.x,0.0)).rgb+texture2D(uArtwork,uv-vec2(blur.x,0.0)).rgb
    +texture2D(uArtwork,uv+vec2(0.0,blur.y)).rgb+texture2D(uArtwork,uv-vec2(0.0,blur.y)).rgb)*0.16;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  float aspect = uResolution.x / uResolution.y;
  float smallSide = min(uResolution.x, uResolution.y);
  vec2 p = (gl_FragCoord.xy - uResolution * vec2(0.5, aspect < 1.0 ? 0.585 : 0.64)) / smallSide;
  float slowTime = uTime;
  float bass = uMotion.x;
  float pulse = uMotion.y;
  float treble = uMotion.z;
  float sustain = uMotion.w;
  float driftEnergy=uDynamics[0].x, driftClock=uDynamics[0].y;
  float cloudEnergy=uDynamics[0].z, cloudClock=uDynamics[0].w;
  float bodyEnergy=uDynamics[1].x, bodyClock=uDynamics[1].y;
  float detailEnergy=uDynamics[1].z, detailClock=uDynamics[1].w;
  float sparkEnergy=uDynamics[2].x, sparkClock=uDynamics[2].y;
  float impactEnergy=uDynamics[2].z;
  p/=1.0+bodyEnergy*0.030+impactEnergy*0.014;
  vec3 background = texture2D(uPalette,vec2(fract(driftClock*0.035+cloudEnergy*0.12),0.5)).rgb*0.042;
  if (uHasArtwork > 0.5) {
    // The field comes from actual delayed sculpture silhouettes, never an
    // unrelated noise/audio deformation. Normal and color samples share this UV.
    vec2 fieldStep=vec2(smallSide*0.018)/uResolution;
    vec2 gradient=vec2(
      texture2D(uLensing,uv+vec2(fieldStep.x,0.0)).r-texture2D(uLensing,uv-vec2(fieldStep.x,0.0)).r,
      texture2D(uLensing,uv+vec2(0.0,fieldStep.y)).r-texture2D(uLensing,uv-vec2(0.0,fieldStep.y)).r);
    vec2 influence=(-gradient+vec2(-gradient.y,gradient.x)*0.25)/(0.035+length(gradient)*1.04);
    float anchor=smoothstep(0.0,0.12,uv.x)*smoothstep(0.0,0.12,1.0-uv.x)
      *smoothstep(0.0,0.12,1.0-uv.y)*smoothstep(0.30,0.48,uv.y);
    vec2 cover=uv-0.5+influence*anchor*(6.5*smallSide/1080.0)/uResolution;
    if (aspect > uArtworkAspect) cover.y *= uArtworkAspect / aspect;
    else cover.x *= aspect / uArtworkAspect;
    cover=rotation(sin(driftClock*0.22)*0.022)*cover;
    cover /= 1.070 + bodyEnergy * 0.022 + impactEnergy * 0.010;
    cover += vec2(sin(driftClock*0.31),cos(driftClock*0.23))*0.007*driftEnergy;
    // Artwork is uploaded premultiplied, so invisible RGB padding cannot leak
    // into palette-constrained colors through texture interpolation.
    vec4 artworkSample = texture2D(uArtwork, cover + 0.5);
    float luminance = dot(artworkSample.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 art=blurredArtwork(cover+0.5,0.0018+cloudEnergy*0.0035);
    art = mix(vec3(dot(art,vec3(0.2126,0.7152,0.0722))), art, 0.40+bodyEnergy*0.15);
    vec3 tint = normalize(uLightColor[0] + uLightColor[1] + vec3(0.8));
    float protection = 0.28 + 0.72 * smoothstep(0.12, 0.52, length(p));
    // Derive subtle relief from the artwork itself, so its detail catches the
    // moving lights without introducing an unrelated texture over the cover.
    vec2 stepUv = vec2(0.0018, 0.0018);
    float rightLuma = dot(texture2D(uArtwork, cover + 0.5 + vec2(stepUv.x,0.0)).rgb, vec3(0.2126,0.7152,0.0722));
    float topLuma = dot(texture2D(uArtwork, cover + 0.5 + vec2(0.0,stepUv.y)).rgb, vec3(0.2126,0.7152,0.0722));
    vec3 artworkNormal = normalize(vec3((luminance-rightLuma)*3.0, (luminance-topLuma)*3.0, 1.0));
    float reliefLight = max(0.0, dot(artworkNormal, normalize(uLightPosition[0])));
    background += art * tint * protection * (0.14 + reliefLight * 0.075);
  }
  // Six causal timelines separate slowly gathered atmosphere from quick hits.
  // Cloud warping is broad and smooth; the cover remains visible through it.
  float textProtection=smoothstep(0.29,0.49,uv.y);
  vec2 cloudP=rotation(cloudClock*0.038)*p*3.1+vec2(cloudClock*0.026,-cloudClock*0.018);
  vec2 curl=vec2(cloudNoise(cloudP+driftClock*0.032),cloudNoise(cloudP+7.3-driftClock*0.021));
  float clouds=cloudNoise(cloudP+curl*1.65);
  float wisps=smoothstep(0.38,0.76,clouds);
  float aura=exp(-dot(p,p)*3.4);
  vec3 cloudColor=mix(uLightColor[1],uLightColor[2],clamp(curl.x+sin(bodyClock*0.09)*0.20,0.0,1.0));
  background+=cloudColor*wisps*aura*(0.052+cloudEnergy*0.16)*textProtection;
  vec2 curtainP=rotation(-driftClock*0.065)*p;
  float curtain=pow(0.5+0.5*sin(curtainP.x*8.0+curl.y*3.8+cloudClock*0.20),6.0);
  float curtainShape=exp(-pow(curtainP.y+sin(curtainP.x*2.7+driftClock*0.10)*0.25,2.0)*4.0);
  background+=mix(uLightColor[0],uLightColor[2],curl.y)*curtain*curtainShape*aura*(0.024+cloudEnergy*0.055)*textProtection;
  // Four narrow, translucent light curtains frame the photograph. Separate
  // broad, middle and fine lobes add depth without a blanket of brighter fog.
  for(int i=0;i<4;i++) {
    float lane=float(i),side=lane<2.0?-1.0:1.0;
    float baseX=lane<2.0?0.16+lane*0.13:0.71+(lane-2.0)*0.13;
    float bend=sin(uv.y*4.4+cloudClock*0.24+lane*1.9)*(0.028+cloudEnergy*0.022)
      +sin(uv.y*8.0-driftClock*0.31+lane)*0.010;
    float distance=(uv.x-baseX-bend-side*sin(driftClock*0.16+lane)*0.018)*aspect;
    float broad=exp(-distance*distance*680.0),middle=exp(-distance*distance*3600.0),fine=exp(-distance*distance*24000.0);
    float endFade=smoothstep(0.30,0.53,uv.y)*(1.0-smoothstep(0.86,1.0,uv.y));
    float ripples=0.70+0.30*sin(uv.y*18.0+detailClock*0.26+lane*2.0);
    vec3 ribbonColor=texture2D(uPalette,vec2(fract(lane*0.24+cloudClock*0.024+detailEnergy*0.08),0.5)).rgb;
    background+=ribbonColor*(broad*0.20+middle*0.43+fine*0.72)*endFade*ripples*(0.070+cloudEnergy*0.105+bodyEnergy*0.035);
  }
  background+=(uLightColor[0]*0.024+uLightColor[1]*0.025)*aura*(0.65+bodyEnergy*0.35);
  // A soft moving shadow anchors the light sculpture without hiding the cover.
  vec2 shadow=(p-vec2(sin(bodyClock*0.09)*0.02,-0.33))/vec2(0.31,0.065);
  background*=1.0-exp(-dot(shadow,shadow))*(0.10+bodyEnergy*0.06);
  // Point-local diffraction and expanding rings follow the decaying impact
  // envelope. Their total light stays restrained even during dense drum rolls.
  vec2 flarePosition=uLightPosition[0].xy*0.33+vec2(sin(bodyClock*0.08),cos(bodyClock*0.11))*0.018;
  vec2 flare=rotation(bodyClock*0.13+driftClock*0.2)*(p-flarePosition);
  float halo=exp(-dot(flare,flare)*130.0);
  float horizontal=exp(-abs(flare.x)*10.0-abs(flare.y)*620.0);
  float vertical=exp(-abs(flare.x)*740.0-abs(flare.y)*21.0);
  float novaRadius=0.055+(1.0-impactEnergy)*0.19;
  float nova=exp(-abs(length(flare)-novaRadius)*200.0);
  float frequency=bodyEnergy;
  vec3 flareColor=mix(uLightColor[0],uLightColor[2],0.20+sparkEnergy*0.16);
  float flareAmount=impactEnergy*uImpactLimit*(0.25+frequency*0.75);
  background+=flareColor*(halo*0.28+horizontal*0.35+vertical*0.24+nova*0.050)
    *flareAmount*textProtection;
  // Broad pulses travel out from the sculpture on the delayed impact clock;
  // their edges and brightness fade before each phase wraps around.
  vec2 pulseP=rotation(driftClock*0.08)*p/vec2(aspect<1.0?0.92:1.35,0.84);
  for(int i=0;i<3;i++) {
    float phase=fract(uDynamics[2].w*0.115+float(i)/3.0);
    float radius=0.20+phase*0.79;
    float edge=length(pulseP)-radius;
    float ring=exp(-edge*edge*12000.0)*0.55+exp(-edge*edge*850.0)*0.20;
    float fade=pow(sin(phase*PI),2.0);
    vec3 ringColor=mix(uLightColor[0],uLightColor[2],float(i)/2.0);
    background+=ringColor*ring*fade*(0.045+impactEnergy*uImpactLimit*0.28)*textProtection;
  }
  float vignette = 1.0 - smoothstep(0.25, 0.83, length((uv - 0.5) * vec2(1.1, 1.0)));
  background *= 0.48 + vignette * 0.52;
  gl_FragColor = vec4(background, 1.0);
}
`;

function fail(message) {
  error.hidden = false;
  error.textContent = message;
  status.textContent = 'Preview unavailable';
  play.disabled = true;
  audio.pause();
}
function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

async function start() {
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: true, stencil: false });
  if (!gl) throw new Error('WebGL is unavailable in this browser. Enable hardware acceleration to preview the material lights.');
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    fail('The graphics context was interrupted. Reload this page to restore the preview.');
  });
  function shader(type, source) {
    const object = gl.createShader(type);
    gl.shaderSource(object, source);
    gl.compileShader(object);
    if (!gl.getShaderParameter(object, gl.COMPILE_STATUS)) throw new Error(`Lighting shader: ${gl.getShaderInfoLog(object)}`);
    return object;
  }
  const program = gl.createProgram();
  const vertex = shader(gl.VERTEX_SHADER, vertexSource);
  const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Lighting program: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  gl.useProgram(program);
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const uniforms = new Map();
  const uniform = name => {
    if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
    return uniforms.get(name);
  };
  async function fetchResource(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
    return response;
  }
  // Do not enable seeking before the media timeline exists. A premature seek can
  // otherwise be discarded when the browser finishes loading a large WAV.
  if (audio.error) throw new Error('This browser could not decode the song. Try a WAV, MP3, or AAC source.');
  const metadataReady = audio.readyState >= 1 ? Promise.resolve() : new Promise((resolve, reject) => {
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', () => reject(new Error('This browser could not decode the song. Try a WAV, MP3, or AAC source.')), { once: true });
  });
  const [profile, timelineBuffer] = await Promise.all([
    fetchResource('/profile.json').then(response => response.json()),
    fetchResource('/timeline.f32').then(response => response.arrayBuffer()),
    metadataReady,
  ]);
  const timeline = new Float32Array(timelineBuffer);
  if (profile.stride !== 181 || timeline.length !== profile.frameCount * profile.stride) throw new Error('Lighting timeline has an incompatible format.');
  preparePreviewCamera(timeline,profile);
  async function texture(path, unit, name, repeat = true) {
    const object = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, object);
    // Complete placeholder texture makes optional artwork deterministic.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([12, 12, 12, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(uniform(name), unit);
    if (!path) return 1;
    const image = new Image();
    image.src = path;
    await image.decode();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, object);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    // Normal / roughness data must bypass browser color conversions.
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, name === 'uArtwork');
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const powerOfTwo = value => value > 0 && (value & (value - 1)) === 0;
    if (repeat && powerOfTwo(image.width) && powerOfTwo(image.height)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    return image.width / image.height;
  }
  // Texture creation mutates shared active WebGL state, so loads are sequential.
  await texture('/albedo.png', 0, 'uAlbedo');
  await texture(profile.hasArtwork ? '/object-normal.png' : '/normal.png', 1, 'uNormal', !profile.hasArtwork);
  await texture(profile.hasArtwork ? '/object-roughness.png' : '/roughness.png', 2, 'uRoughness', !profile.hasArtwork);
  const artworkAspect = await texture(profile.hasArtwork ? '/artwork' : null, 3, 'uArtwork', false);
  const features = new Uint8Array(32 * 2);
  const featureTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_2D, featureTexture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 32, 2, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, features);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(uniform('uFeatures'), 4);
  const strip = new Uint8Array(32);
  const stripTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE5);
  gl.bindTexture(gl.TEXTURE_2D, stripTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 32, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, strip);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const palette = profile.palette;
  if (!palette?.colors?.length) throw new Error('The preview profile does not include a scene palette. Restart the preview server.');
  const drawSculpture = createSculpture(gl, profile.hasArtwork);
  const audioField = createAudioField(gl, palette, profile.lowFlash);
  const glow = createSculptureGlow(gl, (signal,width,height)=>drawSculpture(signal,width,height,0));
  const drawParticles = createDepthParticles(gl);
  gl.useProgram(program);
  // Interpolate only the extracted (or seeded fallback) RGB swatches. No hue
  // rotations or unrelated material colors enter the rendered scene.
  const samplePalette = phase => {
    const wrapped = ((phase % 1) + 1) % 1 * palette.colors.length;
    const left = Math.floor(wrapped), amount = wrapped - left;
    const a = palette.colors[left], b = palette.colors[(left + 1) % palette.colors.length];
    return a.map((value, channel) => value + (b[channel] - value) * amount);
  };
  const palettePixels = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index++) {
    const color = samplePalette(index / 256);
    for (let channel = 0; channel < 3; channel++) palettePixels[index * 4 + channel] = Math.round(Math.max(0, Math.min(1, color[channel])) * 255);
    palettePixels[index * 4 + 3] = 255;
  }
  const paletteTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, paletteTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, palettePixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(uniform('uPalette'), 7);
  const creditColor = (phase, whiten) => `rgb(${samplePalette(phase).map(value => Math.round((value + (1 - value) * whiten) * 255)).join(' ')})`;
  document.documentElement.style.setProperty('--credit-title', creditColor(0, 0.95));
  document.documentElement.style.setProperty('--credit-artist', creditColor(0.34, 0.87));
  document.documentElement.style.setProperty('--credit-accent', creditColor(0.67, 0.70));
  gl.uniform1f(uniform('uHasArtwork'), profile.hasArtwork ? 1 : 0);
  gl.uniform1f(uniform('uImpactLimit'), profile.lowFlash ? 0.4 : 1);
  gl.uniform1f(uniform('uArtworkAspect'), artworkAspect);
  const titleText=typeof profile.title==='string'?profile.title.trim():'';
  const artistText=typeof profile.artist==='string'?profile.artist.trim():'';
  document.title = `${titleText||artistText||'Visu Visu'} · Live resonance`;
  const credits=document.querySelector('#credits'),thumbnail=document.querySelector('#credit-cover');
  document.querySelector('#title').textContent=titleText;
  document.querySelector('#title').hidden=!titleText;
  document.querySelector('#artist').textContent=artistText;
  document.querySelector('#artist').hidden=!artistText;
  credits.dataset.creditCount=String(Number(Boolean(titleText))+Number(Boolean(artistText)));
  credits.dataset.hasTitle=String(Boolean(titleText));
  if(profile.hasArtwork&&(titleText||artistText)) {
    thumbnail.src='/artwork';
    try {await thumbnail.decode();thumbnail.hidden=false;credits.classList.add('has-cover');}
    catch {thumbnail.removeAttribute('src');}
  }
  credits.hidden=!titleText&&!artistText;
  const creditCopy=credits.querySelector('.credit-copy');
  function fitCreditGroup() {
    creditCopy.style.width='';
    credits.style.removeProperty('--measured-cover-size');
    if(!credits.classList.contains('has-cover')||credits.hidden)return;
    // Balanced wrapped lines have a wider CSS box than their visible text. Fit
    // that box before centering the complete lockup, then span its full height.
    for(let pass=0;pass<3;pass++) {
      let lineWidth=0;
      for(const element of creditCopy.children) {
        if(element.hidden)continue;
        const range=document.createRange();
        range.selectNodeContents(element);
        for(const line of range.getClientRects())lineWidth=Math.max(lineWidth,line.width);
      }
      if(lineWidth>0)creditCopy.style.width=`${Math.ceil(lineWidth)+1}px`;
      credits.style.setProperty('--measured-cover-size',`${Math.ceil(creditCopy.getBoundingClientRect().height)}px`);
    }
  }
  fitCreditGroup();
  let creditResizeFrame=0;
  window.addEventListener('resize',()=>{
    cancelAnimationFrame(creditResizeFrame);
    creditResizeFrame=requestAnimationFrame(fitCreditGroup);
  });
  document.querySelector('#duration').textContent = clock(profile.duration);
  seek.max = String(profile.duration);
  seek.disabled = false;
  play.disabled = false;
  status.textContent = 'Ready · WebGL';
  const values = new Float32Array(profile.stride);
  const frozenValues = new Float32Array(profile.stride);
  const lensValues = new Float32Array(profile.stride);
  function sampleTimeline(time, output) {
    const samplePosition = Math.max(0, Math.min(profile.frameCount - 1, time * profile.fps));
    const frame = Math.floor(samplePosition), next = Math.min(frame + 1, profile.frameCount - 1);
    const blend = samplePosition - frame;
    for (let index = 0; index < profile.stride; index++) {
      const value = timeline[frame * profile.stride + index];
      output[index] = value + (timeline[next * profile.stride + index] - value) * blend;
    }
  }
  function uploadSignals(signal) {
    for (let band = 0; band < 32; band++) {
      features[band] = Math.round(Math.max(0, Math.min(1, signal[36 + band])) * 255);
      features[32 + band] = Math.round((Math.max(-1, Math.min(1, signal[68 + band])) * 0.5 + 0.5) * 255);
      strip[band] = Math.round(Math.max(0, Math.min(1, signal[100 + band])) * 255);
    }
    gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, featureTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, features);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, stripTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, strip);
  }
  const fragments=createSurfaceFragments(profile,sampleTimeline,uploadSignals,drawSculpture);
  const lensing=profile.hasArtwork?createSculptureLensing(gl,(captureTime,width,height)=>{
    sampleTimeline(captureTime,lensValues);uploadSignals(lensValues);
    drawSculpture(lensValues,width,height,-1);
  }):null;
  const history = createFrozenHistory(gl, profile.ghosts, (captureTime, width, height) => {
    sampleTimeline(captureTime, frozenValues);
    uploadSignals(frozenValues);
    drawSculpture(frozenValues, width, height, 0);
    const camera=previewCamera(frozenValues,width,height);
    return [camera.x,camera.y];
  });
  const positions = new Float32Array(9);
  const colors = new Float32Array(9);
  const powers = new Float32Array(6);
  let previousTime = -1;
  let previousMode = -1;
  let frames = 0;
  let measuredFrom = performance.now();
  let lastSize = '';
  let fps = 0;
  // Exposes only diagnostic counters; source paths and audio data stay on the server.
  window.lightingPreview = { ready: true, renderedFrames: 0, fps: 0, time: 0, width: 0, height: 0, mode: 0, ghostPixelHash: id => history.pixelHash(id), lensPixelStats:()=>lensing?.pixelStats(), palette: { source: palette.source, colors: palette.colors } };
  function draw(now) {
    const time = Math.max(0, Math.min(profile.duration, audio.currentTime || 0));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const initialWidth = Math.max(1, Math.round(innerWidth * pixelRatio));
    const initialHeight = Math.max(1, Math.round(innerHeight * pixelRatio));
    const budgetScale = Math.min(1, Math.sqrt(1920 * 1080 / (initialWidth * initialHeight)));
    const width = Math.round(initialWidth * budgetScale);
    const height = Math.round(initialHeight * budgetScale);
    const size = `${width}x${height}`;
    const mode = Number(view.value);
    if (time !== previousTime || mode !== previousMode || size !== lastSize) {
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      if (size !== lastSize) {
        setPreviewHero(innerWidth,innerHeight,credits.hidden?innerHeight*0.72:credits.getBoundingClientRect().top);
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
        gl.uniform2f(uniform('uResolution'), width, height);
        lastSize = size;
      }
      sampleTimeline(time, values);
      if(mode===0)fragments.update(time);
      history.update(time, width, height, mode === 0);
      lensing?.update(time,width,height);
      // Capturing history temporarily uploads old FFT/material light data.
      // Restore the live textures and drawing state before painting this frame.
      uploadSignals(values);
      if(mode===0)glow.capture(values,width,height);
      gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, width, height); gl.uniform2f(uniform('uResolution'), width, height);
      for (let i = 0; i < 3; i++) {
        const offset = 12 + i * 8;
        for (let axis = 0; axis < 3; axis++) {
          positions[i * 3 + axis] = values[offset + axis];
          colors[i * 3 + axis] = values[offset + 3 + axis];
        }
        powers[i * 2] = values[offset + 6];
        powers[i * 2 + 1] = values[offset + 7];
      }
      gl.uniform1f(uniform('uTime'), values[0]);
      gl.uniform4f(uniform('uMotion'), values[139], values[145], values[143], values[137]);
      gl.uniform4fv(uniform('uDynamics[0]'), values.subarray(135, 147));
      gl.uniform3f(uniform('uAmbient'), values[8], values[9], values[10]);
      gl.uniform1f(uniform('uExposure'), values[11]);
      gl.uniform3f(uniform('uLightPosition[0]'), positions[0], positions[1], positions[2]);
      gl.uniform3fv(uniform('uLightColor[0]'), colors);
      gl.uniform2fv(uniform('uLightPower[0]'), powers);
      gl.uniform1f(uniform('uView'), mode);
      lensing?.bind();gl.uniform1i(uniform('uLensing'),6);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if(mode===0){glow.draw(values,width,height);drawParticles(values,width,height,false);}
      if (mode === 0) { audioField.update(values, width, height); audioField.draw(false); }
      if (mode === 0) history.draw(time, width, height);
      drawSculpture(values, width, height, mode,mode===0?{tears:fragments.tears(time)}:{});
      if(mode===0){fragments.draw(time,width,height);uploadSignals(values);}
      if(mode===0)drawParticles(values,width,height,true);
      if (mode === 0) audioField.draw(true);
      frames++;
      window.lightingPreview.renderedFrames++;
      previousTime = time;
      previousMode = mode;
    }
    if (now - measuredFrom >= 1000) {
      fps = frames * 1000 / (now - measuredFrom);
      status.textContent = audio.paused ? 'Paused · WebGL' : `${Math.round(fps)} fps · WebGL`;
      frames = 0;
      measuredFrom = now;
    }
    seek.value = String(time);
    document.querySelector('#elapsed').textContent = clock(time);
    Object.assign(window.lightingPreview, { fps, time, width, height, mode, history: history.inspect(time), lensing:lensing?.inspect(), fragments:fragments.inspect(time) });
    if (!gl.isContextLost()) requestAnimationFrame(draw);
  }
  play.addEventListener('click', async () => {
    if (!audio.paused) audio.pause();
    else {
      try {
        if (audio.ended) audio.currentTime = 0;
        await audio.play();
      } catch (reason) { fail(`Audio playback failed: ${reason.message}`); }
    }
  });
  const updatePlay = () => {
    play.textContent = audio.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  };
  audio.addEventListener('play', updatePlay);
  audio.addEventListener('pause', updatePlay);
  audio.addEventListener('ended', updatePlay);
  audio.addEventListener('error', () => fail('This browser could not decode the song. Try a WAV, MP3, or AAC source.'));
  seek.addEventListener('input', () => { audio.currentTime = Number(seek.value); });
  document.addEventListener('keydown', event => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      play.click();
    }
  });
  requestAnimationFrame(draw);
}
start().catch(reason => fail(reason instanceof Error ? reason.message : String(reason)));
