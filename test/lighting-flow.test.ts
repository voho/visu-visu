import { describe, expect, test } from 'bun:test';
import { sampleSpectralFlowTimeline, buildFlowRibbons } from '../src/preview/lighting-flow.js';
import { spectralFlowPaths } from '../src/render/spectral-flow.js';
import { presenceAt } from '../src/render/conductor.js';
import { randomPalette } from '../src/render/palette.js';

const profile={stride:181,duration:30};
const palette=randomPalette('flow-preview');
function sample(time:number,values:Float32Array):void {
  values[2]=0.6;values[3]=0.4;values[4]=0.2;values[7]=0.7;
  values[136]=time*0.3;values[139]=0.65;values[141]=0.45;
  values[142]=time*0.9;values[143]=0.35;values[145]=Math.max(0,Math.sin(time)*0.4);
  for(let i=0;i<32;i++) {
    values[149+i]=(1-i/32)*(0.4+Math.sin(time+i)*0.2);
    values[68+i]=Math.sin(i/32*Math.PI*6+time)*0.4;
  }
}

describe('spectral flow preview',()=>{
  test('reconstructs bounded absolute-time history and agrees with song entrance/exit',()=>{
    const queried:number[]=[];
    const samples=sampleSpectralFlowTimeline(6,profile,(time,values)=>{queried.push(time);sample(time,values);});
    expect(queried).toEqual([4.6,5,5.35,5.68,6]);
    expect(samples.length).toBe(5);
    for(const entry of samples) {
      expect(entry.state.time+entry.age).toBeCloseTo(6,10);
      expect(entry.state.spectrum.length).toBe(32);
      expect(Array.from(entry.state.waveform).some(value=>value<0)).toBe(true);
      expect(entry.state.bass).toBeCloseTo(0.65*(0.30+0.70*0.6),6);
      expect(entry.state.mid).toBeCloseTo(0.45*(0.5+0.5*0.4),6);
      expect(entry.state.treble).toBeCloseTo(0.35*(0.5+0.5*0.2),6);
    }
    for(const duration of [0.2,2,6,30,180])for(const time of [0,0.2,duration*0.4,duration*0.9,duration]) {
      const samples=sampleSpectralFlowTimeline(time,{...profile,duration},sample);
      expect(samples.every(entry=>entry.state.time>=0)).toBe(true);
      expect(new Set(samples.map(entry=>entry.state.time)).size).toBe(samples.length);
      for(const entry of samples)expect(entry.state.presence).toBeCloseTo(presenceAt(entry.state.time,duration),10);
    }
  });

  test('seeking forwards or backwards produces identical independent ribbon data',()=>{
    const frame={width:1920,height:1080,creditFloor:0.34,creditCeiling:0.93};
    const build=(time:number)=>buildFlowRibbons(spectralFlowPaths(sampleSpectralFlowTimeline(time,profile,sample),'flow-preview'),palette.colors,frame);
    const original=build(6),saved=original.slice();
    expect(original.length).toBeGreaterThan(0);
    build(14);build(0.1);build(29);
    expect(build(6)).toEqual(saved);
    expect(original).toEqual(saved);
    expect(Array.from(original).every(Number.isFinite)).toBe(true);
    expect(original.length/10).toBeLessThan(20_000);
  });

  test('all ribbon and glow channels interpolate only the scene palette, including neutral covers',()=>{
    const paths=spectralFlowPaths(sampleSpectralFlowTimeline(6,profile,sample),'flow-preview');
    const frame={width:1080,height:1920,creditFloor:0.32,creditCeiling:0.94};
    const gray=buildFlowRibbons(paths,[[0.2,0.2,0.2],[0.8,0.8,0.8]],frame);
    const blue=buildFlowRibbons(paths,[[0,0,0.2],[0,0,0.8]],frame);
    for(let i=0;i<gray.length;i+=10) {
      expect(gray[i+2]).toBe(gray[i+3]);expect(gray[i+3]).toBe(gray[i+4]);
      expect(blue[i+2]).toBe(0);expect(blue[i+3]).toBe(0);
      expect(blue[i+4]).toBeGreaterThanOrEqual(0.19);
      expect(blue[i+4]).toBeLessThanOrEqual(0.81);
    }
    const subdued=buildFlowRibbons(paths,[[0,0,0.2],[0,0,0.8]],{...frame,lowFlash:true});
    for(let i=0;i<blue.length;i+=10) {
      expect(subdued[i]).toBe(blue[i]);expect(subdued[i+1]).toBe(blue[i+1]);
      expect(subdued[i+5]).toBeCloseTo(blue[i+5]!*0.78,6);
    }
  });
});
