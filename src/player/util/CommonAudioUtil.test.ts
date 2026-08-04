import { describe, it, expect } from 'vitest';
import { loadLegacyModule } from '../test-support/loadLegacyModule';
import { CommonAudioUtil, type G726State } from './CommonAudioUtil';

interface LegacyCommonAudioUtil {
  g726_init_state(): G726State;
  predictor_zero(state: G726State): number;
  predictor_pole(state: G726State): number;
  step_size(state: G726State): number;
  quantize(d: number, y: number, table: number[], size: number): number;
  reconstruct(sign: number, dqln: number, y: number): number;
  update(
    code_size: number,
    y: number,
    wi: number,
    fi: number,
    dq: number,
    sr: number,
    dqsez: number,
    state: G726State
  ): G726State;
}

const LegacyCommonAudioUtilCtor = loadLegacyModule<new () => LegacyCommonAudioUtil>('Util/audioUtil.js', 'CommonAudioUtil');

// A representative G.721 24kbps quantization table (7-level), used purely to
// exercise quantize()/reconstruct() identically on both implementations.
const QUAN_TABLE = [-124, 80, 178, 246, 300, 349, 400];

describe('CommonAudioUtil parity with the legacy player’s Util/audioUtil.js', () => {
  it('g726_init_state produces the same initial state shape', () => {
    const legacy = new LegacyCommonAudioUtilCtor();
    const ported = new CommonAudioUtil();
    expect(ported.g726_init_state()).toEqual(legacy.g726_init_state());
  });

  it('predictor_zero/predictor_pole/step_size match for the same state', () => {
    const legacy = new LegacyCommonAudioUtilCtor();
    const ported = new CommonAudioUtil();
    const legacyState = legacy.g726_init_state();
    const portedState = ported.g726_init_state();

    expect(ported.predictor_zero(portedState)).toBe(legacy.predictor_zero(legacyState));
    expect(ported.predictor_pole(portedState)).toBe(legacy.predictor_pole(legacyState));
    expect(ported.step_size(portedState)).toBe(legacy.step_size(legacyState));
  });

  it('quantize/reconstruct match across a range of sample values', () => {
    const legacy = new LegacyCommonAudioUtilCtor();
    const ported = new CommonAudioUtil();
    const samples = [-300, -1, 0, 1, 250, 5000, -5000];

    for (const d of samples) {
      const y = 544;
      expect(ported.quantize(d, y, QUAN_TABLE, QUAN_TABLE.length)).toBe(
        legacy.quantize(d, y, QUAN_TABLE, QUAN_TABLE.length)
      );
    }
    for (const dqln of [0, 128, 512, -10]) {
      expect(ported.reconstruct(0, dqln, 544)).toBe(legacy.reconstruct(0, dqln, 544));
      expect(ported.reconstruct(1, dqln, 544)).toBe(legacy.reconstruct(1, dqln, 544));
    }
  });

  it('update() evolves the state identically over a short simulated decode sequence', () => {
    const legacy = new LegacyCommonAudioUtilCtor();
    const ported = new CommonAudioUtil();
    let legacyState = legacy.g726_init_state();
    let portedState = ported.g726_init_state();

    const inputSamples = [12, -340, 900, -12000, 3];
    for (const d of inputSamples) {
      const legacyY = legacy.step_size(legacyState);
      const portedY = ported.step_size(portedState);
      expect(portedY).toBe(legacyY);

      const legacyCode = legacy.quantize(d, legacyY, QUAN_TABLE, QUAN_TABLE.length);
      const portedCode = ported.quantize(d, portedY, QUAN_TABLE, QUAN_TABLE.length);
      expect(portedCode).toBe(legacyCode);

      const legacyDq = legacy.reconstruct(d < 0 ? 1 : 0, legacyCode, legacyY);
      const portedDq = ported.reconstruct(d < 0 ? 1 : 0, portedCode, portedY);
      expect(portedDq).toBe(legacyDq);

      const legacySez = legacy.predictor_zero(legacyState) + legacy.predictor_pole(legacyState);
      const portedSez = ported.predictor_zero(portedState) + ported.predictor_pole(portedState);
      expect(portedSez).toBe(legacySez);

      legacyState = legacy.update(2, legacyY, legacyY, 0, legacyDq, legacyDq, legacySez, legacyState);
      portedState = ported.update(2, portedY, portedY, 0, portedDq, portedDq, portedSez, portedState);
      expect(portedState).toEqual(legacyState);
    }
  });
});
