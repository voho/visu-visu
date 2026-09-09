// The live sculpture follows the same toroidal flow, morph clocks, and bass-first
// geometry as render/resonance.ts. The GPU shades its translucent material skin
// and the original-style luminous filaments as one coherent object.
import { previewCamera } from '/lighting-camera.js';
export function createSculpture(gl, hasArtwork = false) {
  const vertexFeatures = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0;
  const vertex = `
precision highp float;
attribute vec2 aParameter;
uniform vec2 uResolution;
uniform vec4 uMotion;
uniform vec4 uClock;
uniform vec4 uDynamics[3];
uniform vec4 uCamera;
uniform sampler2D uFeatures;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec2 vUv;
varying float vEnergy;
const float TAU=6.28318530718;
vec2 feature(float x) { ${vertexFeatures ? 'float wave=texture2D(uFeatures,vec2(x,0.75)).r*0.5+texture2D(uFeatures,vec2(clamp(x-0.03125,0.016,0.984),0.75)).r*0.25+texture2D(uFeatures,vec2(clamp(x+0.03125,0.016,0.984),0.75)).r*0.25; return vec2(texture2D(uFeatures,vec2(x,0.25)).r,wave*2.0-1.0);' : 'return vec2(uMotion.x,0.0);'} }
vec3 form(vec2 parameter) {
  float u=parameter.x*TAU;
  float phase=parameter.y*TAU;
  float slow=uClock.x;
  float fast=uClock.y;
  float bass=uMotion.x;
  float mids=uMotion.y;
  float treble=uMotion.z;
  float pulse=uMotion.w;
  float drift=slow*0.46+0.8;
  float morph=slow*1.8;
  float orb=0.5+sin(morph*0.54+2.0)*0.5;
  float flower=0.5+sin(morph*0.67+0.8)*0.5;
  float knot=0.5+sin(morph*0.41+1.9)*0.5;
  float angle=u+slow*0.12+0.8+sin(u*2.0+drift*0.4)*knot*0.12;
  float bandPosition=0.5-cos(u+sin(phase)*0.18+drift*0.22)*0.5;
  vec2 signal=feature(bandPosition);
  float displacement=signal.x*(1.0-bandPosition*0.86);
  float wave=signal.y;
  float flow=phase+u+drift+sin(u+drift*0.7)*(0.52+knot*0.46)
    +sin(u*3.0+drift*0.45)*(0.25+mids*0.12);
  float v=flow+sin(flow*2.0)*(0.26+flower*0.2);
  float lobe=cos(u*3.0-drift*0.62);
  float major=0.57-orb*0.2+bass*0.045+displacement*0.12+wave*0.015
    +lobe*(0.035+flower*0.065+bass*0.12)*(1.0-orb*0.4)
    +sin(u*2.0+drift*0.4)*(0.02+mids*0.025+displacement*0.035)
    +pulse*(0.035+sin(u*3.0-fast*0.68)*0.12);
  float tube=(0.17+orb*0.18+mids*0.035)
    *(1.0+sin(u*2.0+drift)*(0.18+mids*0.1+bass*0.12))
    +pulse*(0.025+sin(u*2.0+phase)*0.025)
    +treble*sin(u*7.0-fast*1.6+phase)*0.009;
  float distance=major+cos(v)*tube;
  float stretch=sin(drift*0.8)*(0.04+uClock.z*0.07+bass*0.055);
  vec3 p=vec3(cos(angle)*distance*(1.0+stretch),sin(angle)*distance*(1.0-stretch),sin(v)*tube
    +sin(u*2.0+drift*0.6)*(0.025+knot*0.105+bass*0.075)
    +sin(u*3.0-fast*0.68)*pulse*0.085);
  float ax=0.55+sin(morph*0.34+1.9)*0.78;
  float ay=sin(morph*0.29+0.8)*0.92;
  float az=morph*0.11+sin(morph*0.21+1.9)*0.26+sin(uDynamics[0].y*0.13)*0.025;
  p.yz=mat2(cos(ax),sin(ax),-sin(ax),cos(ax))*p.yz;
  p.xz=mat2(cos(ay),-sin(ay),sin(ay),cos(ay))*p.xz;
  p.xy=mat2(cos(az),sin(az),-sin(az),cos(az))*p.xy;
  return p;
}
void main() {
  vec3 p=form(aParameter);
  vec3 tangent=form(aParameter+vec2(0.0008,0.0))-p;
  vec3 bitangent=form(aParameter+vec2(0.0,0.0008))-p;
  vNormal=normalize(cross(tangent,bitangent));
  vTangent=normalize(tangent);
  vBitangent=normalize(bitangent);
  vPosition=p;
  vUv=aParameter;
  vEnergy=feature(0.5-cos(aParameter.x*TAU+uClock.x*0.1)*0.5).x;
  float aspect=uResolution.x/uResolution.y;
  float size=min(uResolution.x,uResolution.y)*(aspect<1.0?0.432:0.338)*uCamera.w;
  float perspective=3.8/(3.8-p.z);
  vec2 projected=mat2(cos(uCamera.z),sin(uCamera.z),-sin(uCamera.z),cos(uCamera.z))*p.xy;
  vec2 pixel=uResolution*uCamera.xy+projected*size*perspective;
  gl_Position=vec4(pixel/uResolution*2.0-1.0,-p.z*0.35,1.0);
}
`;
  const fragment = `
precision highp float;
uniform vec2 uResolution;
uniform vec3 uLightPosition[3];
uniform vec3 uLightColor[3];
uniform vec2 uLightPower[3];
uniform vec3 uAmbient;
uniform float uExposure;
uniform vec4 uMotion;
uniform vec4 uClock;
uniform vec4 uDynamics[3];
uniform sampler2D uAlbedo;
uniform sampler2D uNormal;
uniform sampler2D uRoughness;
uniform sampler2D uFeatures;
uniform sampler2D uStrip;
uniform sampler2D uPalette;
uniform sampler2D uArtwork;
uniform float uHasArtwork;
uniform vec3 uStripState;
uniform float uPass;
uniform float uView;
varying vec3 vPosition;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec2 vUv;
varying float vEnergy;
const float TAU=6.28318530718;
vec3 lighting(vec3 normal,vec3 albedo,float roughness) {
 const vec3 luma=vec3(0.2126,0.7152,0.0722);
 if(uHasArtwork<0.5) albedo=vec3(dot(albedo,luma));
 vec3 view=normalize(vec3(0.0,0.0,3.4)-vPosition);
 float nv=max(dot(normal,view),0.0);
 float exponent=4.0+pow(1.0-roughness,2.0)*92.0;
 float gloss=0.15+(1.0-roughness)*0.45;
 // Photographic pigment keeps its own RGB under neutral diffuse light. The
 // source-palette specular reflections still move over that attached image.
 vec3 color=albedo*(uHasArtwork>0.5?vec3(0.16+dot(uAmbient,luma)):uAmbient);
 for(int i=0;i<3;i++) {
  vec3 delta=uLightPosition[i]-vPosition;
  float dd=max(dot(delta,delta),0.00001);
  vec3 light=delta*inversesqrt(dd);
  float nl=max(dot(normal,light),0.0);
  vec3 halfway=normalize(light+view);
  float fresnel=0.06+0.94*pow(1.0-clamp(dot(view,halfway),0.0,1.0),5.0);
  float specular=pow(max(dot(normal,halfway),0.0),exponent)*gloss*(0.25+fresnel*2.0);
  float rim=pow(1.0-nv,3.0)*0.045*(1.0-roughness*0.6);
  vec3 diffuseLight=uHasArtwork>0.5?vec3(dot(uLightColor[i],luma)):uLightColor[i];
  color+=uLightPower[i].x/(1.0+dd*uLightPower[i].y)
    *(diffuseLight*albedo*0.88*nl+uLightColor[i]*(specular+rim)*nl);
 }
 // The FFT itself is an environment strip light. Normal-map relief changes
 // reflected direction, selecting another frequency/color from the same strip.
 if(nv>0.0 && uStripState.z>0.0) {
  vec3 reflected=2.0*nv*normal-view;
  float sx=uStripState.x*reflected.x+uStripState.y*reflected.z;
  float sz=-uStripState.y*reflected.x+uStripState.x*reflected.z;
  float coordinate=atan(sx,sz)/TAU+0.5;
  float blur=0.009+roughness*roughness*0.11;
  float radiance=texture2D(uStrip,vec2(coordinate,0.5)).r*0.5
    +texture2D(uStrip,vec2(coordinate-blur,0.5)).r*0.25
    +texture2D(uStrip,vec2(coordinate+blur,0.5)).r*0.25;
  float gate=exp(-reflected.y*reflected.y/(0.022+roughness*roughness*0.48+(1.0-coordinate)*0.06));
  float fresnel=0.16+0.84*pow(1.0-nv,5.0);
  float amount=radiance*gate*uStripState.z*(0.28+(1.0-roughness)*0.4+fresnel*0.45);
  vec3 reflectionPigment=uHasArtwork>0.5?vec3(dot(albedo,luma)):albedo;
  color+=amount*mix(uLightColor[0],uLightColor[2],coordinate)*(reflectionPigment*0.35+0.65);
 }
 color*=uExposure;
 if(uHasArtwork>0.5) {
  color/=1.0+max(color.r,max(color.g,color.b));
  return color*inversesqrt(max(0.01,dot(color,luma)));
 }
 return sqrt(color/(vec3(1.0)+color));
}
void main() {
 vec2 uv=vUv*vec2(2.0,1.0)+vec2(uClock.x*0.006,0.0);
 // Mirror each closed axis to keep the full picture attached to the sculpture
 // without cropped borders, moving UVs, or an abrupt repeating image seam.
 vec2 mirrorDirection=vec2(1.0)-step(vec2(0.5),fract(vUv))*2.0;
 if(uHasArtwork>0.5) uv=1.0-abs(fract(vUv)*2.0-1.0);
 vec3 rawAlbedo=texture2D(uAlbedo,uv).rgb;
 float materialDetail=dot(rawAlbedo,vec3(0.2126,0.7152,0.0722));
 vec3 pigment=texture2D(uPalette,vec2(fract(vUv.y+uClock.x*0.009),0.5)).rgb;
 // Preserve the generated texture's relief/luminance while its pigment comes
 // exclusively from this image's palette, including neutral monochrome images.
 vec3 albedo=mix(vec3(1.0),pigment,0.78)*(0.35+materialDetail*0.80);
 vec3 bump=normalize(texture2D(uNormal,uv).rgb*2.0-1.0);
 float coverage=1.0;
 if(uHasArtwork>0.5) {
  vec4 photo=texture2D(uArtwork,uv);
  coverage=photo.a;
  rawAlbedo=photo.a>0.00001?photo.rgb/photo.a:vec3(0.0);
  albedo=rawAlbedo;
  vec2 seamDistance=min(fract(vUv),min(abs(fract(vUv)-0.5),1.0-fract(vUv)));
  bump.xy*=mirrorDirection*smoothstep(vec2(0.0),vec2(0.018),seamDistance);
 }
 float roughness=clamp(texture2D(uRoughness,uv).r,0.08,1.0);
 vec3 geometric=normalize(vNormal);
 if(!gl_FrontFacing) geometric=-geometric;
 vec3 tangent=normalize(vTangent-geometric*dot(vTangent,geometric));
 vec3 bitangent=normalize(cross(geometric,tangent));
 bitangent*=dot(bitangent,vBitangent)<0.0?-1.0:1.0;
 float featureX=clamp(vUv.x,0.016,0.984);
 float spectrum=texture2D(uFeatures,vec2(featureX,0.25)).r;
 float wave=texture2D(uFeatures,vec2(featureX,0.75)).r*2.0-1.0;
 float slope=texture2D(uFeatures,vec2(min(0.984,featureX+0.03125),0.25)).r-spectrum;
 vec3 normal=normalize(geometric*bump.z+tangent*(bump.x*0.42-slope*0.14)+bitangent*bump.y*0.42);
 vec3 color=uView< -0.5?vec3(1.0):lighting(normal,rawAlbedo,roughness);
 float graph=0.30+spectrum*(1.0-featureX*0.78)*(0.22+uMotion.x*0.16);
 float osc=0.72+wave*(0.05+uMotion.x*0.11);
 float spectrumLine=exp(-abs(vUv.y-graph)*140.0);
 float waveLine=exp(-abs(vUv.y-osc)*180.0);
 color+=(uLightColor[0]*spectrumLine*(0.09+uMotion.x*0.15)+uLightColor[2]*waveLine*0.11);
 if(uView>0.5) {
  if(uView<1.5) color=albedo;
  else if(uView<2.5) color=bump*0.5+0.5;
  else color=vec3(roughness);
  if(coverage<0.01)discard;
  gl_FragColor=vec4(color,coverage);return;
 }
 if(uPass<0.5) {
  float facing=abs(dot(normal,normalize(vec3(0.0,0.0,3.4)-vPosition)));
  float alpha=((uHasArtwork>0.5?0.44:0.20)+pow(1.0-facing,2.0)*0.19)*(0.7+vEnergy*0.3)*coverage;
  gl_FragColor=vec4(color*0.8,alpha*smoothstep(0.312,0.358,gl_FragCoord.y/uResolution.y));
 } else {
  float tracer=pow(max(0.0,sin(vUv.x*TAU*2.0-uDynamics[2].y*1.35+vUv.y*TAU)),28.0);
  vec3 tint=uView< -0.5?vec3(1.0):mix(uLightColor[0],uLightColor[1],0.5+sin(vUv.y*TAU+uClock.x*0.15)*0.5);
  float light=0.32+vEnergy*0.24+tracer*(0.25+uMotion.z*0.55);
  color=mix(color,tint,0.64)*light;
  gl_FragColor=vec4(color,0.50*coverage*smoothstep(0.312,0.358,gl_FragCoord.y/uResolution.y));
 }
}
`;
  function compile(type, source) {
    const shader=gl.createShader(type); gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const program=gl.createProgram();
  const vs=compile(gl.VERTEX_SHADER,vertex), fs=compile(gl.FRAGMENT_SHADER,fragment);
  gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
  gl.deleteShader(vs);gl.deleteShader(fs);gl.useProgram(program);
  const uniforms=new Map();
  const uniform=name=>{if(!uniforms.has(name))uniforms.set(name,gl.getUniformLocation(program,name));return uniforms.get(name);};
  const countU=192,countV=64;
  const parameters=new Float32Array((countU+1)*(countV+1)*2);
  let cursor=0;
  for(let v=0;v<=countV;v++)for(let u=0;u<=countU;u++) {
    parameters[cursor++]=u/countU;
    const phase=v/countV*TAU;
    parameters[cursor++]=v/countV+(Math.sin(phase*3+0.8)*0.2+Math.sin(phase*6+1.6)*0.05)/TAU;
  }
  const indices=[];const lines=[];
  for(let v=0;v<countV;v++)for(let u=0;u<countU;u++) {
    const a=v*(countU+1)+u,b=a+1,c=a+countU+1,d=c+1;
    indices.push(a,b,c,b,d,c);lines.push(a,b);
  }
  const parameterBuffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,parameterBuffer);gl.bufferData(gl.ARRAY_BUFFER,parameters,gl.STATIC_DRAW);
  const surfaceBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,surfaceBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);
  const lineBuffer=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,lineBuffer);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(lines),gl.STATIC_DRAW);
  const attribute=gl.getAttribLocation(program,'aParameter');
  for(const [name,unit]of[['uAlbedo',0],['uNormal',1],['uRoughness',2],['uArtwork',3],['uFeatures',4],['uStrip',5],['uPalette',7]])gl.uniform1i(uniform(name),unit);
  gl.uniform1f(uniform('uHasArtwork'),hasArtwork?1:0);
  const positions=new Float32Array(9),colors=new Float32Array(9),powers=new Float32Array(6);
  return (values,width,height,mode)=>{
    gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER,parameterBuffer);gl.enableVertexAttribArray(attribute);gl.vertexAttribPointer(attribute,2,gl.FLOAT,false,0,0);
    gl.uniform2f(uniform('uResolution'),width,height);
    const camera=previewCamera(values,width,height);
    gl.uniform4f(uniform('uCamera'),camera.x,camera.y,camera.roll,camera.zoom);
    gl.uniform4f(uniform('uMotion'),values[139],values[141],values[143],values[145]);
    gl.uniform4f(uniform('uClock'),values[0],values[1],values[137],values[143]);
    gl.uniform4fv(uniform('uDynamics[0]'),values.subarray(135,147));
    gl.uniform3f(uniform('uAmbient'),values[8],values[9],values[10]);gl.uniform1f(uniform('uExposure'),values[11]);
    gl.uniform3f(uniform('uStripState'),values[132],values[133],values[134]);
    gl.uniform1f(uniform('uView'),mode);gl.uniform1f(uniform('uPass'),0);
    for(let i=0;i<3;i++) {const offset=12+i*8;for(let j=0;j<3;j++){positions[i*3+j]=values[offset+j];colors[i*3+j]=values[offset+3+j];}powers[i*2]=values[offset+6];powers[i*2+1]=values[offset+7];}
    gl.uniform3fv(uniform('uLightPosition[0]'),positions);gl.uniform3fv(uniform('uLightColor[0]'),colors);gl.uniform2fv(uniform('uLightPower[0]'),powers);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,surfaceBuffer);
    if(mode>0) {
      gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
      gl.clear(gl.DEPTH_BUFFER_BIT);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
    } else {
      gl.disable(gl.DEPTH_TEST);gl.depthMask(false);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
      gl.enable(gl.CULL_FACE);gl.cullFace(gl.FRONT);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);
      gl.cullFace(gl.BACK);gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_SHORT,0);gl.disable(gl.CULL_FACE);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,lineBuffer);gl.uniform1f(uniform('uPass'),1);gl.blendFunc(gl.SRC_ALPHA,gl.ONE);
      gl.drawElements(gl.LINES,lines.length,gl.UNSIGNED_SHORT,0);
    }
    gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);gl.depthMask(true);
  };
}
const TAU=Math.PI*2;
