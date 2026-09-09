import type {SurfaceFragmentCandidate,SurfaceFragmentEvent,SurfaceFragmentPose} from '../render/surface-fragments.js';
export interface VisibleSurfaceFragment extends SurfaceFragmentCandidate {
  anchor: [number,number,number];
  projected: {x:number;y:number;z:number};
  visibility:number;
}
export interface SurfacePatchDrawOptions {
  fragment?: {bounds:number[];motion:number[];angles:number[];seed:number;blur:number;depth:number};
  tears?: Array<{bounds:number[];seed:number;strength:number}>;
}
export function selectVisibleFragments(values: ArrayLike<number>, event: SurfaceFragmentEvent, seed: string): VisibleSurfaceFragment[];
export function createSurfaceFragments(
  profile:{stride:number;seed?:string;ghosts?:{events:readonly SurfaceFragmentEvent[]}},
  sampleTimeline:(time:number,output:Float32Array)=>void,
  uploadSignals:(values:Float32Array)=>void,
  drawSculpture:(values:Float32Array,width:number,height:number,mode:number,options:SurfacePatchDrawOptions)=>void,
):{
  update(time:number):void;
  tears(time:number):Array<{bounds:number[];seed:number;strength:number}>;
  draw(time:number,width:number,height:number):void;
  inspect(time:number):{
    captureCount:number;cached:number;tearCount:number;
    snapshots:Array<{id:number;captureTime:number;sourceHash:string;pieces:Array<{id:string;u:number;v:number;visibility:number}&Partial<SurfaceFragmentPose>>}>;
  };
};
