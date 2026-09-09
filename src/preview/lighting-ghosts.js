// Immutable low-resolution captures of the entire lit sculpture. History never
// advances its geometry, lights, spectrum, or camera; only this composite ages.
export function createFrozenHistory(gl, schedule, capture) {
  const snapshots = new Map();
  const framebuffer = gl.createFramebuffer();
  let sizeKey = '';
  let captureCount = 0;
  const vertex = `attribute vec2 aPosition; void main(){gl_Position=vec4(aPosition,0.0,1.0);}`;
  const fragment = `
precision highp float;
uniform sampler2D uSnapshot;
uniform vec2 uResolution;
uniform vec2 uCenter;
uniform vec2 uBlur;
uniform float uScale;
uniform float uOpacity;
uniform float uDissolve;
uniform float uSeed;
float hash(vec2 p) {
  vec3 q=fract(vec3(p.xyx)*0.1031+uSeed);
  q+=dot(q,q.yzx+33.33); return fract((q.x+q.y)*q.z);
}
float noise(vec2 p) {
  vec2 c=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
  return mix(mix(hash(c),hash(c+vec2(1.0,0.0)),f.x),
    mix(hash(c+vec2(0.0,1.0)),hash(c+1.0),f.x),f.y);
}
vec3 sampleAt(vec2 uv) {
  if(uv.x<0.0||uv.y<0.0||uv.x>1.0||uv.y>1.0)return vec3(0.0);
  return texture2D(uSnapshot,uv).rgb;
}
void main() {
  vec2 uv=gl_FragCoord.xy/uResolution;
  vec2 frozenUv=(uv-uCenter)/uScale+uCenter;
  vec2 blur=uBlur/uScale;
  vec3 color=sampleAt(frozenUv)*0.24;
  color+=(sampleAt(frozenUv+vec2(blur.x,0.0))+sampleAt(frozenUv-vec2(blur.x,0.0))
    +sampleAt(frozenUv+vec2(0.0,blur.y))+sampleAt(frozenUv-vec2(0.0,blur.y)))*0.115;
  vec2 diagonal=blur*0.70710678;
  color+=(sampleAt(frozenUv+diagonal)+sampleAt(frozenUv-diagonal)
    +sampleAt(frozenUv+vec2(diagonal.x,-diagonal.y))+sampleAt(frozenUv+vec2(-diagonal.x,diagonal.y)))*0.075;
  // Noise stays attached to the frozen image and only its threshold erodes.
  float erosion=noise(frozenUv*vec2(9.0,11.0))*0.68+noise(frozenUv*vec2(23.0,27.0))*0.32;
  float threshold=uDissolve*0.86-0.12;
  float mask=smoothstep(threshold,threshold+0.20,erosion);
  float credits=smoothstep(0.32,0.48,uv.y);
  float edges=smoothstep(0.01,0.11,uv.x)*smoothstep(0.01,0.11,1.0-uv.x)
    *smoothstep(0.015,0.13,1.0-uv.y);
  gl_FragColor=vec4(color*uOpacity*mask*credits*edges,1.0);
}
`;
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Frozen history shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }
  const program = gl.createProgram();
  const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Frozen history program: ${gl.getProgramInfoLog(program)}`);
  gl.deleteShader(vs); gl.deleteShader(fs);
  const vertices = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const attribute = gl.getAttribLocation(program, 'aPosition');
  const uniforms = new Map();
  const uniform = name => {
    if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
    return uniforms.get(name);
  };
  gl.useProgram(program); gl.uniform1i(uniform('uSnapshot'), 6);
  function remove(id) {
    const snapshot = snapshots.get(id);
    if (snapshot) gl.deleteTexture(snapshot.texture);
    snapshots.delete(id);
  }
  function eventsAt(time) {
    return (schedule?.events ?? []).filter(event => event.captureTime <= time && time < event.captureTime + schedule.lifetime).slice(-3);
  }
  function envelopeAt(age) {
    const rows = schedule.envelope;
    const position = Math.max(0, Math.min(rows.length - 1, age * schedule.envelopeFps));
    const a = Math.floor(position), b = Math.min(rows.length - 1, a + 1), mix = position - a;
    const sample = {};
    for (const key of ['scale', 'opacity', 'blur', 'dissolve']) sample[key] = rows[a][key] + (rows[b][key] - rows[a][key]) * mix;
    return sample;
  }
  function update(time, width, height, enabled) {
    const nextSize = `${width}x${height}`;
    if (nextSize !== sizeKey) {
      for (const id of snapshots.keys()) remove(id);
      sizeKey = nextSize;
    }
    const events = eventsAt(time);
    const active = new Set(events.map(event => event.id));
    for (const id of snapshots.keys()) if (!active.has(id)) remove(id);
    if (!enabled) return;
    const ratio = Math.min(0.5, 768 / Math.max(width, height));
    const smallWidth = Math.max(64, Math.round(width * ratio));
    const smallHeight = Math.max(64, Math.round(height * ratio));
    for (const event of events) {
      if (snapshots.has(event.id)) continue;
      const texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, smallWidth, smallHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Could not allocate a frozen history capture');
      gl.viewport(0, 0, smallWidth, smallHeight);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      // Callback restores exactly the historical feature textures before drawing.
      const center = capture(event.captureTime, smallWidth, smallHeight);
      snapshots.set(event.id, { texture, width: smallWidth, height: smallHeight, captureTime: event.captureTime, center });
      captureCount++;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, width, height);
  }
  function draw(time, width, height) {
    gl.useProgram(program); gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
    gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(uniform('uResolution'), width, height);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.enable(gl.BLEND);
    // Screen blending preserves the already premultiplied color captured on black.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    for (const event of eventsAt(time)) {
      const snapshot = snapshots.get(event.id);
      if (!snapshot) continue;
      const envelope = envelopeAt(time - event.captureTime);
      gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, snapshot.texture);
      gl.uniform2f(uniform('uCenter'), snapshot.center[0], snapshot.center[1]);
      gl.uniform1f(uniform('uScale'), envelope.scale);
      gl.uniform1f(uniform('uOpacity'), envelope.opacity * event.strength);
      gl.uniform1f(uniform('uDissolve'), envelope.dissolve);
      gl.uniform1f(uniform('uSeed'), event.id * 0.00371);
      const radius = Math.min(width, height) * (width < height ? 0.432 : 0.338);
      gl.uniform2f(uniform('uBlur'), envelope.blur * radius / width, envelope.blur * radius / height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
  }
  return {
    update, draw,
    inspect(time) {
      return { captureCount, snapshots: eventsAt(time).filter(event => snapshots.has(event.id)).map(event => ({
        id: event.id, captureTime: event.captureTime, age: time - event.captureTime,
        width: snapshots.get(event.id).width, height: snapshots.get(event.id).height,
        pixelStats: snapshots.get(event.id).pixelStats,
        ...envelopeAt(time - event.captureTime),
      })) };
    },
    // Explicit QA only: regular animation never reads pixels back from the GPU.
    pixelHash(id) {
      const snapshot = snapshots.get(id); if (!snapshot) return null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, snapshot.texture, 0);
      const pixels = new Uint8Array(snapshot.width * snapshot.height * 4);
      gl.readPixels(0, 0, snapshot.width, snapshot.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let hash = 2166136261, maximum = 0, colorSum = 0, coloredPixels = 0;
      for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619);
      for (let index = 0; index < pixels.length; index += 4) {
        const brightest = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
        maximum = Math.max(maximum, brightest);
        colorSum += pixels[index] + pixels[index + 1] + pixels[index + 2];
        if (brightest > 3) coloredPixels++;
      }
      snapshot.pixelStats = { maximum, mean: colorSum / (snapshot.width * snapshot.height * 3), coloredPixels };
      return (hash >>> 0).toString(16);
    },
  };
}
