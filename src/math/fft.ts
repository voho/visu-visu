export class RealFft {
  readonly size: number;
  private readonly cosine: Float64Array;
  private readonly sine: Float64Array;
  private readonly reversed: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, received ${size}`);
    }

    this.size = size;
    this.cosine = new Float64Array(size / 2);
    this.sine = new Float64Array(size / 2);
    this.reversed = new Uint32Array(size);

    for (let index = 0; index < size / 2; index += 1) {
      const angle = (-2 * Math.PI * index) / size;
      this.cosine[index] = Math.cos(angle);
      this.sine[index] = Math.sin(angle);
    }

    const bits = Math.log2(size);
    for (let index = 0; index < size; index += 1) {
      let source = index;
      let target = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        target = (target << 1) | (source & 1);
        source >>>= 1;
      }
      this.reversed[index] = target;
    }
  }

  magnitudes(input: Float32Array): Float32Array {
    if (input.length !== this.size) {
      throw new Error(`Expected ${this.size} FFT samples, received ${input.length}`);
    }

    const real = new Float64Array(this.size);
    const imaginary = new Float64Array(this.size);

    for (let index = 0; index < this.size; index += 1) {
      real[index] = input[this.reversed[index] ?? 0] ?? 0;
    }

    for (let blockSize = 2; blockSize <= this.size; blockSize *= 2) {
      const half = blockSize / 2;
      const tableStep = this.size / blockSize;

      for (let block = 0; block < this.size; block += blockSize) {
        for (let offset = 0; offset < half; offset += 1) {
          const tableIndex = offset * tableStep;
          const evenIndex = block + offset;
          const oddIndex = evenIndex + half;
          const oddReal = real[oddIndex] ?? 0;
          const oddImaginary = imaginary[oddIndex] ?? 0;
          const cosine = this.cosine[tableIndex] ?? 1;
          const sine = this.sine[tableIndex] ?? 0;
          const rotatedReal = oddReal * cosine - oddImaginary * sine;
          const rotatedImaginary = oddReal * sine + oddImaginary * cosine;
          const evenReal = real[evenIndex] ?? 0;
          const evenImaginary = imaginary[evenIndex] ?? 0;

          real[evenIndex] = evenReal + rotatedReal;
          imaginary[evenIndex] = evenImaginary + rotatedImaginary;
          real[oddIndex] = evenReal - rotatedReal;
          imaginary[oddIndex] = evenImaginary - rotatedImaginary;
        }
      }
    }

    const output = new Float32Array(this.size / 2 + 1);
    for (let index = 0; index < output.length; index += 1) {
      const realValue = real[index] ?? 0;
      const imaginaryValue = imaginary[index] ?? 0;
      output[index] = Math.hypot(realValue, imaginaryValue) / this.size;
    }
    return output;
  }
}
