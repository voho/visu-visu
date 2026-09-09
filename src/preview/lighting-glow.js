import { previewCamera } from '/lighting-camera.js';

// A fresh quarter-size emission image adds soft light around the current object.
// Historical ghosts remain separate immutable captures with their own decay.
export function createSculptureGlow(gl, capture) {
  const framebuffer=gl.createFramebuffer(),texture=gl.createTexture();
  const program=gl.createProgram();
  const sources=[
    [gl.VERTEX_SHADER,'attribute vec2 aPosition; void main(){gl_Position=vec4(aPosition,0.0,1.0);}'],
    [gl.FRAGMENT_SHADER,`
precision highp float;
uniform sampler2D uEmission;
uniform vec2 uResolution;
uniform vec4 uCamera;
uniform vec4 uMotion;
const float TAU=6.28318530718;
void main() {
  vec2 uv=gl_FragCoord.xy/uResolution;
  vec2 relative=(uv-uCamera.xy)*uResolution/min(uResolution.x,uResolution.y);
  float roll=sin(uMotion.y*0.12)*0.055;
  relative=mat2(cos(roll),sin(roll),-sin(roll),cos(roll))*relative/(1.055+uMotion.x*0.035);
  vec2 center=relative*min(uResolution.x,uResolution.y)/uResolution+uCamera.xy;
  float radius=0.010+uMotion.z*0.012+uMotion.x*0.005;
  vec3 emission=vec3(0.0);
  for(int i=0;i<13;i++) {
    float point=float(i),distance=sqrt((point+0.5)/13.0);
    float angle=point*2.39996323+uMotion.y*0.035;
    vec2 offset=vec2(cos(angle),sin(angle))*distance*radius*min(uResolution.x,uResolution.y)/uResolution;
    emission+=texture2D(uEmission,clamp(center+offset,0.0,1.0)).rgb/13.0;
  }
  float credits=smoothstep(0.32,0.49,uv.y);
  float strength=0.22+uMotion.z*0.14+uMotion.w*0.08;
  gl_FragColor=vec4(emission*strength*credits,1.0);
}`],
  ];
  for(const [type,source] of sources) {
    const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(`Sculpture glow shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program,shader);gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(`Sculpture glow program: ${gl.getProgramInfoLog(program)}`);
  const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  const attribute=gl.getAttribLocation(program,'aPosition');
  const uniform=name=>gl.getUniformLocation(program,name);
  const resolution=uniform('uResolution'),cameraLocation=uniform('uCamera'),motion=uniform('uMotion');
  gl.useProgram(program);gl.uniform1i(uniform('uEmission'),6);
  let width=0,height=0;
  return {
    capture(values, fullWidth, fullHeight) {
      const ratio=Math.min(0.25,512/Math.max(fullWidth,fullHeight));
      const nextWidth=Math.max(32,Math.round(fullWidth*ratio)),nextHeight=Math.max(32,Math.round(fullHeight*ratio));
      gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,texture);
      if(nextWidth!==width||nextHeight!==height) {
        width=nextWidth;height=nextHeight;
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Could not allocate sculpture glow');
      gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      capture(values,width,height);
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,fullWidth,fullHeight);
    },
    draw(values, width, height) {
      const camera=previewCamera(values,width,height);
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
      gl.uniform2f(resolution,width,height);gl.uniform4f(cameraLocation,camera.x,camera.y,camera.roll,camera.zoom);
      gl.uniform4f(motion,values[145],values[138],values[137],values[139]);
      gl.activeTexture(gl.TEXTURE6);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.disable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_COLOR);
      gl.drawArrays(gl.TRIANGLES,0,3);gl.disable(gl.BLEND);
    },
  };
}
