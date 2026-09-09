import { createSculpture } from '/lighting-mesh.js';
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
vec3 dustLayer(vec2 p,float grid,float clock,float energy,float depth) {
  vec2 travel=vec2(clock*(0.027+depth*0.027),-clock*(0.018+depth*0.013));
  vec2 coordinates=p*grid+travel;
  vec2 cell=floor(coordinates);
  float seed=hash21(cell+depth*12.3);
  vec2 center=vec2(0.16+seed*0.68,0.16+fract(seed*43.17)*0.68);
  vec2 distance=fract(coordinates)-center;
  float radius=900.0/(1.0+depth*1.8+energy*depth*2.0);
  float spot=exp(-dot(distance,distance)*radius);
  float halo=exp(-dot(distance,distance)*radius*0.15)*0.035;
  float twinkle=0.55+0.45*sin(seed*31.0+clock*(0.22+seed*0.18));
  return mix(uLightColor[0],uLightColor[2],seed)*(spot+halo)*twinkle
    *(0.032+energy*(0.055+depth*0.030));
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
  p/=1.0+bodyEnergy*0.016+impactEnergy*0.008;
  vec3 background = vec3(0.023, 0.025, 0.043);
  if (uHasArtwork > 0.5) {
    vec2 cover = uv - 0.5;
    if (aspect > uArtworkAspect) cover.y *= uArtworkAspect / aspect;
    else cover.x *= aspect / uArtworkAspect;
    cover /= 1.045 + pulse * 0.009 + bass * 0.006 + bodyEnergy * 0.008;
    cover += vec2(sin(driftClock*0.31),cos(driftClock*0.23))*0.0025*driftEnergy;
    vec3 art = texture2D(uArtwork, cover + 0.5).rgb;
    float luminance = dot(art, vec3(0.2126, 0.7152, 0.0722));
    art = mix(vec3(luminance), art, 0.32);
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
  vec2 cloudP=p*3.2+vec2(cloudClock*0.018,-cloudClock*0.012);
  vec2 curl=vec2(cloudNoise(cloudP+driftClock*0.012),cloudNoise(cloudP+7.3-driftClock*0.009));
  float clouds=cloudNoise(cloudP+curl*1.65);
  float wisps=smoothstep(0.38,0.76,clouds);
  float aura=exp(-dot(p,p)*3.4);
  vec3 cloudColor=mix(uLightColor[1],uLightColor[2],clamp(curl.x,0.0,1.0));
  background+=cloudColor*wisps*aura*(0.032+cloudEnergy*0.094);
  background+=(uLightColor[0]*0.024+uLightColor[1]*0.025)*aura*(0.65+bodyEnergy*0.35);
  // A soft moving shadow anchors the light sculpture without hiding the cover.
  vec2 shadow=(p-vec2(sin(bodyClock*0.09)*0.02,-0.33))/vec2(0.31,0.065);
  background*=1.0-exp(-dot(shadow,shadow))*(0.10+bodyEnergy*0.06);
  float textProtection=smoothstep(0.29,0.49,uv.y);
  vec3 particles=dustLayer(p,24.0,sparkClock,sparkEnergy,0.15)
    +dustLayer(p,13.0,detailClock,detailEnergy,0.55)
    +dustLayer(p,6.0,bodyClock,bodyEnergy,1.0);
  background+=particles*textProtection;
  // Point-local diffraction and expanding rings follow the decaying impact
  // envelope. Their total light stays restrained even during dense drum rolls.
  vec2 flarePosition=uLightPosition[0].xy*0.33+vec2(sin(bodyClock*0.08),cos(bodyClock*0.11))*0.018;
  vec2 flare=p-flarePosition;
  float halo=exp(-dot(flare,flare)*180.0);
  float horizontal=exp(-abs(flare.x)*13.0-abs(flare.y)*900.0);
  float vertical=exp(-abs(flare.x)*1000.0-abs(flare.y)*27.0);
  float novaRadius=0.055+(1.0-impactEnergy)*0.19;
  float nova=exp(-abs(length(flare)-novaRadius)*200.0);
  float frequency=texture2D(uFeatures,vec2(0.16,0.25)).r;
  vec3 flareColor=mix(uLightColor[0],uLightColor[2],0.20+sparkEnergy*0.16);
  float flareAmount=impactEnergy*uImpactLimit*(0.25+frequency*0.75);
  background+=flareColor*(halo*0.20+horizontal*0.27+vertical*0.19+nova*0.030)
    *flareAmount*textProtection;
  float vignette = 1.0 - smoothstep(0.25, 0.83, length((uv - 0.5) * vec2(1.1, 1.0)));
  background *= 0.48 + vignette * 0.52;
  // Quiet lower third for centered track/artist credits.
  background *= 0.57 + smoothstep(0.17, 0.4, uv.y) * 0.43;
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
  const drawSculpture = createSculpture(gl);
  gl.useProgram(program);
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
  if (profile.stride !== 147 || timeline.length !== profile.frameCount * profile.stride) throw new Error('Lighting timeline has an incompatible format.');
  async function texture(path, unit, name, repeat = true) {
    const object = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, object);
    // Complete placeholder texture makes optional artwork deterministic.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([12, 12, 20, 255]));
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
  await texture('/normal.png', 1, 'uNormal');
  await texture('/roughness.png', 2, 'uRoughness');
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
  gl.uniform1f(uniform('uHasArtwork'), profile.hasArtwork ? 1 : 0);
  gl.uniform1f(uniform('uImpactLimit'), profile.lowFlash ? 0.4 : 1);
  gl.uniform1f(uniform('uArtworkAspect'), artworkAspect);
  document.title = `${profile.title} · Live resonance`;
  document.querySelector('#title').textContent = profile.title;
  document.querySelector('#artist').textContent = profile.artist;
  document.querySelector('#artist').hidden = !profile.artist;
  document.querySelector('#duration').textContent = clock(profile.duration);
  seek.max = String(profile.duration);
  seek.disabled = false;
  play.disabled = false;
  status.textContent = 'Ready · WebGL';
  const values = new Float32Array(profile.stride);
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
  window.lightingPreview = { ready: true, renderedFrames: 0, fps: 0, time: 0, width: 0, height: 0, mode: 0 };
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
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
        gl.uniform2f(uniform('uResolution'), width, height);
        lastSize = size;
      }
      const samplePosition = Math.min(profile.frameCount - 1, time * profile.fps);
      const frame = Math.floor(samplePosition);
      const next = Math.min(frame + 1, profile.frameCount - 1);
      const blend = samplePosition - frame;
      for (let i = 0; i < profile.stride; i++) {
        const left = timeline[frame * profile.stride + i];
        values[i] = left + (timeline[next * profile.stride + i] - left) * blend;
      }
      for (let i = 0; i < 3; i++) {
        const offset = 12 + i * 8;
        for (let axis = 0; axis < 3; axis++) {
          positions[i * 3 + axis] = values[offset + axis];
          colors[i * 3 + axis] = values[offset + 3 + axis];
        }
        powers[i * 2] = values[offset + 6];
        powers[i * 2 + 1] = values[offset + 7];
      }
      for (let band = 0; band < 32; band++) {
        features[band] = Math.round(Math.max(0, Math.min(1, values[36 + band])) * 255);
        features[32 + band] = Math.round((Math.max(-1, Math.min(1, values[68 + band])) * 0.5 + 0.5) * 255);
      }
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, featureTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 2, gl.LUMINANCE, gl.UNSIGNED_BYTE, features);
      for (let band = 0; band < 32; band++) strip[band] = Math.round(Math.max(0, Math.min(1, values[100 + band])) * 255);
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, stripTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 32, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, strip);
      gl.uniform1f(uniform('uTime'), values[0]);
      gl.uniform4f(uniform('uMotion'), values[2], values[5], values[4], values[7]);
      gl.uniform4fv(uniform('uDynamics[0]'), values.subarray(135, 147));
      gl.uniform3f(uniform('uAmbient'), values[8], values[9], values[10]);
      gl.uniform1f(uniform('uExposure'), values[11]);
      gl.uniform3f(uniform('uLightPosition[0]'), positions[0], positions[1], positions[2]);
      gl.uniform3fv(uniform('uLightColor[0]'), colors);
      gl.uniform2fv(uniform('uLightPower[0]'), powers);
      gl.uniform1f(uniform('uView'), mode);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawSculpture(values, width, height, mode);
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
    Object.assign(window.lightingPreview, { fps, time, width, height, mode });
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
