# Third-party visualization components

Promo typography bundles [Cormorant Garamond](https://github.com/google/fonts/tree/main/ofl/cormorantgaramond) and [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope) under the SIL Open Font License 1.1. The unmodified fonts, their full license notices and provenance are in [assets/fonts](../assets/fonts/README.md). Fonts are loaded locally; rendering does not contact a font service.

The optional MilkDrop engine uses [Butterchurn](https://github.com/jberg/butterchurn), a WebGL implementation of the MilkDrop visualizer, and selected presets from [butterchurn-presets](https://github.com/jberg/butterchurn-presets). The pinned packages are **butterchurn 2.6.7** and **butterchurn-presets 2.4.7**. Their published package metadata and repositories identify both as MIT licensed: [engine license](https://github.com/jberg/butterchurn/blob/master/LICENSE), [preset collection license](https://github.com/jberg/butterchurn-presets/blob/master/LICENSE). Preset display names retain their original creator credits in the catalogue.

This is a MilkDrop 2-compatible rendering path. It does not run the Windows MilkDrop3 application or promise support for MilkDrop3's double-preset format, newer extensions or private shaders. MilkDrop3 remains a separate project; its [README](https://github.com/milkdrop2077/MilkDrop3#readme) describes those additional features.

Butterchurn supplies the preset equations, framebuffer feedback, distortion, waveform rendering and preset blending. visu-visu supplies the audio preparation, deterministic preset selection, fixed-step export, cover/credit composition and MP4 encoding. Its excerpt warmup simulates at most four seconds of preceding audio; this is bounded preroll, not a reconstruction of the complete track's earlier framebuffer history.

The following notice applies to the Butterchurn engine and preset collection:

```text
MIT License

Copyright (c) 2013-2018 Jordan Berg

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
