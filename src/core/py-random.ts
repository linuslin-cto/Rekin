// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Minimal CPython 3 `random.Random` (MT19937) for byte-identical shuffle with
 * harness2's `assign_ids`. Only the seed/init + random()/shuffle surface is ported.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private mt: number[] = new Array(N).fill(0);
  private mti = N + 1;

  constructor(seed?: number) {
    if (seed !== undefined) this.seed(seed);
  }

  seed(n: number): void {
    // CPython Random.seed(int) for non-negative ints uses init_by_array on the
    // absolute value's 32-bit limbs (version=2). For seeds that fit in one limb
    // this matches init_genrand(seed).
    let x = Math.trunc(n);
    if (!Number.isFinite(x)) x = 0;
    // JS number is fine for sha1[:12] hex seeds (< 2^48).
    if (x < 0) x = -x;
    const key: number[] = [];
    if (x === 0) {
      key.push(0);
    } else {
      while (x > 0) {
        key.push(x >>> 0);
        x = Math.floor(x / 0x100000000);
      }
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (this.mti = 1; this.mti < N; this.mti++) {
      const prev = this.mt[this.mti - 1]!;
      this.mt[this.mti] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + this.mti) >>> 0;
    }
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      const prev = this.mt[i - 1]!;
      this.mt[i] =
        ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = ((this.mt[i]! ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  private genrandInt32(): number {
    let y: number;
    const mag01 = [0, MATRIX_A];
    if (this.mti >= N) {
      let kk: number;
      for (kk = 0; kk < N - M; kk++) {
        y = (this.mt[kk]! & UPPER_MASK) | (this.mt[kk + 1]! & LOWER_MASK);
        this.mt[kk] = this.mt[kk + M]! ^ (y >>> 1) ^ mag01[y & 1]!;
      }
      for (; kk < N - 1; kk++) {
        y = (this.mt[kk]! & UPPER_MASK) | (this.mt[kk + 1]! & LOWER_MASK);
        this.mt[kk] = this.mt[kk + (M - N)]! ^ (y >>> 1) ^ mag01[y & 1]!;
      }
      y = (this.mt[N - 1]! & UPPER_MASK) | (this.mt[0]! & LOWER_MASK);
      this.mt[N - 1] = this.mt[M - 1]! ^ (y >>> 1) ^ mag01[y & 1]!;
      this.mti = 0;
    }
    y = this.mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** CPython `random()` — 53-bit resolution in [0, 1). */
  random(): number {
    const a = this.genrandInt32() >>> 5;
    const b = this.genrandInt32() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }

  /** CPython `Random.getrandbits(k)` for k in 1..53 (JS-safe integer range). */
  getrandbits(k: number): number {
    if (k <= 0) throw new Error("number of bits must be greater than zero");
    if (k <= 32) return this.genrandInt32() >>> (32 - k);
    // Assemble little-endian 32-bit words like CPython's random_getrandbits.
    const words = Math.floor((k - 1) / 32) + 1;
    let result = 0;
    let shift = 0;
    for (let i = 0; i < words; i++) {
      let word = this.genrandInt32();
      if (i + 1 === words) {
        const leftover = k % 32;
        if (leftover) word >>>= 32 - leftover;
      }
      result += word * 2 ** shift;
      shift += 32;
    }
    return result;
  }

  /** CPython 3.11+ `_randbelow_with_getrandbits`. */
  randbelow(n: number): number {
    if (n <= 0) throw new Error("n must be greater than 0");
    // int.bit_length() for positive n that fit in 32 bits.
    const bits = 32 - Math.clz32(n);
    let r = this.getrandbits(bits);
    while (r >= n) r = this.getrandbits(bits);
    return r;
  }

  /** Match CPython 3.11+ `Random.shuffle` (`_randbelow`). */
  shuffle<T>(arr: T[]): void {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
  }
}
