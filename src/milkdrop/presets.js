// Presets from butterchurn-presets 2.4.7 (MIT, Jordan Berg). Keep original
// author names here; runtime clones protect the shared catalogue from mutation.
import vortex from 'butterchurn-presets/presets/converted/Geiss - Vortex 1.json';
import ribbons from 'butterchurn-presets/presets/converted/Geiss - Ribbons.json';
import dust from 'butterchurn-presets/presets/converted/Geiss - Cosmic Dust 2.json';
import fog from 'butterchurn-presets/presets/converted/Geiss - Fog Tunnel.json';
import julia from 'butterchurn-presets/presets/converted/Geiss - Julia Fractal 3.json';
import plasma from 'butterchurn-presets/presets/converted/Geiss - Plasma 2.json';
import tunnel from 'butterchurn-presets/presets/converted/Flexi + Martin - tunnel of supraschismatika.json';
import moebius from 'butterchurn-presets/presets/converted/Flexi - motion blurred moebius fractal - early alpha version.json';

export const MILKDROP_PRESETS=Object.freeze([
  {id:'vortex',name:'Geiss - Vortex 1',family:'rotating vortex'},
  {id:'ribbons',name:'Geiss - Ribbons',family:'flowing ribbons'},
  {id:'cosmic-dust',name:'Geiss - Cosmic Dust 2',family:'particle starfield'},
  {id:'fog-tunnel',name:'Geiss - Fog Tunnel',family:'fog tunnel'},
  {id:'julia-fractal',name:'Geiss - Julia Fractal 3',family:'fractal feedback'},
  {id:'plasma',name:'Geiss - Plasma 2',family:'reaction diffusion'},
  {id:'folded-tunnel',name:'Flexi + Martin - tunnel of supraschismatika',family:'folded tunnel'},
  {id:'moebius',name:'Flexi - motion blurred moebius fractal - early alpha version',family:'Moebius folds'},
].map(Object.freeze));
const presets={vortex,ribbons,'cosmic-dust':dust,'fog-tunnel':fog,'julia-fractal':julia,plasma,'folded-tunnel':tunnel,moebius};

export function milkdropPreset(id) {
  if(!Object.hasOwn(presets,id))throw new Error(`Unknown MilkDrop preset: ${id}`);
  return structuredClone(presets[id]);
}
