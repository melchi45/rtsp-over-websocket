/**
 * Ported from the legacy player’s Util/audioUtil — G.72x ADPCM helper routines
 * shared by the G.726 audio decoders. Bitwise arithmetic is copied verbatim;
 * this is reference DSP code where the exact operations (not just the
 * mathematical intent) are the contract.
 */
export interface G726State {
  a: number[];
  b: number[];
  pk: number[];
  dq: number[];
  sr: number[];
  yl: number;
  yu: number;
  dms: number;
  dml: number;
  ap: number;
  td: number;
}

const POWER2 = [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x100, 0x200, 0x400, 0x800, 0x1000, 0x2000, 0x4000];

export class CommonAudioUtil {
  private quan(val: number, table: number[], size: number): number {
    let i = 0;
    let k = 0;
    for (i = 0; i < size; i++) {
      if (val < table[k]) {
        break;
      } else {
        k++;
      }
    }
    return i;
  }

  private fmult(an: number, srn: number): number {
    const anmag = an > 0 ? an : (-an) & 0x1fff;
    const anexp = this.quan(anmag, POWER2, 15) - 6;
    const anmant = anmag === 0 ? 32 : anexp >= 0 ? anmag >> anexp : anmag << -anexp;
    const wanexp = anexp + ((srn >> 6) & 0xf) - 13;

    const wanmant = (anmant * (srn & parseInt('077', 8)) + 0x30) >> 4;
    const retval = wanexp >= 0 ? (wanmant << wanexp) & 0x7fff : wanmant >> -wanexp;

    return (an ^ srn) < 0 ? -retval : retval;
  }

  g726_init_state(): G726State {
    const state: G726State = {
      a: new Array(2),
      b: new Array(6),
      pk: new Array(2),
      dq: new Array(6),
      sr: new Array(2),
      yl: 34816,
      yu: 544,
      dms: 0,
      dml: 0,
      ap: 0,
      td: 0
    };
    for (let i = 0; i < 2; i++) {
      state.a[i] = 0;
      state.pk[i] = 0;
      state.sr[i] = 32;
    }
    for (let i = 0; i < 6; i++) {
      state.b[i] = 0;
      state.dq[i] = 32;
    }
    return state;
  }

  predictor_zero(state: G726State): number {
    let sezi = this.fmult(state.b[0] >> 2, state.dq[0]);
    for (let i = 1; i < 6; i++) {
      sezi += this.fmult(state.b[i] >> 2, state.dq[i]);
    }
    return sezi;
  }

  predictor_pole(state: G726State): number {
    return this.fmult(state.a[1] >> 2, state.sr[1]) + this.fmult(state.a[0] >> 2, state.sr[0]);
  }

  step_size(state: G726State): number {
    if (state.ap >= 256) {
      return state.yu;
    }
    let y = state.yl >> 6;
    const dif = state.yu - y;
    const al = state.ap >> 2;
    if (dif > 0) {
      y += (dif * al) >> 6;
    } else if (dif < 0) {
      y += (dif * al + 0x3f) >> 6;
    }
    return y;
  }

  quantize(d: number, y: number, table: number[], size: number): number {
    const dqm = Math.abs(d);
    const exp = this.quan(dqm >> 1, POWER2, 15);
    const mant = ((dqm << 7) >> exp) & 0x7f;
    const dl = (exp << 7) + mant;
    const dln = dl - (y >> 2);
    const i = this.quan(dln, table, size);

    if (d < 0) {
      return (size << 1) + 1 - i;
    } else if (i === 0) {
      return (size << 1) + 1;
    } else {
      return i;
    }
  }

  reconstruct(sign: number, dqln: number, y: number): number {
    const dql = dqln + (y >> 2);
    if (dql < 0) {
      return sign ? -0x8000 : 0;
    }
    const dex = (dql >> 7) & 15;
    const dqt = 128 + (dql & 127);
    const dq = (dqt << 7) >> (14 - dex);
    return sign ? dq - 0x8000 : dq;
  }

  update(
    code_size: number,
    y: number,
    wi: number,
    fi: number,
    dq: number,
    sr: number,
    dqsez: number,
    state: G726State
  ): G726State {
    const pk0 = dqsez < 0 ? 1 : 0;
    let mag = dq & 0x7fff;

    const ylint = state.yl >> 15;
    const ylfrac = (state.yl >> 10) & 0x1f;
    const thr1 = (32 + ylfrac) << ylint;
    const thr2 = ylint > 9 ? 31 << 10 : thr1;
    const dqthr = (thr2 + (thr2 >> 1)) >> 1;
    let tr: number;
    if (state.td === 0) {
      tr = 0;
    } else if (mag <= dqthr) {
      tr = 0;
    } else {
      tr = 1;
    }

    state.yu = y + ((wi - y) >> 5);
    if (state.yu < 544) {
      state.yu = 544;
    } else if (state.yu > 5120) {
      state.yu = 5120;
    }
    state.yl += state.yu + ((-state.yl) >> 6);

    let a2p: number;
    if (tr === 1) {
      state.a[0] = 0;
      state.a[1] = 0;
      state.b[0] = 0;
      state.b[1] = 0;
      state.b[2] = 0;
      state.b[3] = 0;
      state.b[4] = 0;
      state.b[5] = 0;
      a2p = 0;
    } else {
      const pks1 = pk0 ^ state.pk[0];

      a2p = state.a[1] - (state.a[1] >> 7);
      if (dqsez !== 0) {
        const fa1 = pks1 ? state.a[0] : -state.a[0];
        if (fa1 < -8191) {
          a2p -= 0x100;
        } else if (fa1 > 8191) {
          a2p += 0xff;
        } else {
          a2p += fa1 >> 5;
        }

        if (pk0 ^ state.pk[1]) {
          if (a2p <= -12160) {
            a2p = -12288;
          } else if (a2p >= 12416) {
            a2p = 12288;
          } else {
            a2p -= 0x80;
          }
        } else if (a2p <= -12416) {
          a2p = -12288;
        } else if (a2p >= 12160) {
          a2p = 12288;
        } else {
          a2p += 0x80;
        }
      }

      state.a[1] = a2p;

      state.a[0] -= state.a[0] >> 8;
      if (dqsez !== 0) {
        if (pks1 === 0) {
          state.a[0] += 192;
        } else {
          state.a[0] -= 192;
        }
      }

      const a1ul = 15360 - a2p;
      if (state.a[0] < -a1ul) {
        state.a[0] = -a1ul;
      } else if (state.a[0] > a1ul) {
        state.a[0] = a1ul;
      }

      for (let cnt = 0; cnt < 6; cnt++) {
        if (code_size === 5) {
          state.b[cnt] -= state.b[cnt] >> 9;
        } else {
          state.b[cnt] -= state.b[cnt] >> 8;
        }
        if (dq & 0x7fff) {
          if ((dq ^ state.dq[cnt]) >= 0) {
            state.b[cnt] += 128;
          } else {
            state.b[cnt] -= 128;
          }
        }
      }
    }

    for (let cnt = 5; cnt > 0; cnt--) {
      state.dq[cnt] = state.dq[cnt - 1];
    }
    let exp: number;
    if (mag === 0) {
      state.dq[0] = dq >= 0 ? 0x20 : 0xfc20;
    } else {
      exp = this.quan(mag, POWER2, 15);
      state.dq[0] =
        dq >= 0 ? (exp << 6) + ((mag << 6) >> exp) : (exp << 6) + ((mag << 6) >> exp) - 0x400;
    }

    state.sr[1] = state.sr[0];
    if (sr === 0) {
      state.sr[0] = 0x20;
    } else if (sr > 0) {
      exp = this.quan(sr, POWER2, 15);
      state.sr[0] = (exp << 6) + ((sr << 6) >> exp);
    } else if (sr > -32768) {
      mag = -sr;
      exp = this.quan(mag, POWER2, 15);
      state.sr[0] = (exp << 6) + ((mag << 6) >> exp) - 0x400;
    } else {
      state.sr[0] = 0xfc20;
    }

    state.pk[1] = state.pk[0];
    state.pk[0] = pk0;

    if (tr === 1) {
      state.td = 0;
    } else if (a2p < -11776) {
      state.td = 1;
    } else {
      state.td = 0;
    }

    state.dms += (fi - state.dms) >> 5;
    state.dml += ((fi << 2) - state.dml) >> 7;

    if (tr === 1) {
      state.ap = 256;
    } else if (y < 1536) {
      state.ap += (0x200 - state.ap) >> 4;
    } else if (state.td === 1) {
      state.ap += (0x200 - state.ap) >> 4;
    } else if (Math.abs((state.dms << 2) - state.dml) >= state.dml >> 3) {
      state.ap += (0x200 - state.ap) >> 4;
    } else {
      state.ap += -state.ap >> 4;
    }
    return state;
  }
}
