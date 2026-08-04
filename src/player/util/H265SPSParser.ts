import { RTSPOverWebSocketMap } from './RTSPOverWebSocketMap';

export interface SpsSizeInfo {
  width: number;
  height: number;
  decodeSize: number;
  cropWidth: number;
  cropHeight: number;
}

type SpsValue = number | number[] | undefined;

function reverseBits(bits: number, size: number): number {
  let binaryString = bits.toString(2).split('').reverse().join('');
  while (binaryString.length < size) {
    binaryString += '0';
  }
  return parseInt(binaryString, 2);
}

export class H265SPSParser {
  private bitCount = 0;
  private spsMap = new RTSPOverWebSocketMap<SpsValue>();
  private spsBytes: Uint8Array = new Uint8Array(0);

  private nalUnitExtractRbsp(src: Uint8Array): Uint8Array {
    const dst: number[] = [];
    const len = src.byteLength;
    let i = 0;

    while (i < 2 && i < len) {
      dst.push(src[i++]);
    }
    while (i + 2 < len) {
      if (src[i] === 0x00 && src[i + 1] === 0x00 && src[i + 2] === 0x03) {
        dst.push(src[i++]);
        dst.push(src[i++]);
        i++;
      } else {
        dst.push(src[i++]);
      }
    }
    while (i < len) {
      dst.push(src[i++]);
    }
    return new Uint8Array(dst);
  }

  private getBit(base: Uint8Array, offset: number): number {
    const curBytes = (this.bitCount + offset) >> 3;
    const bitOffset = (this.bitCount + offset) & 0x00000007;
    return (base[curBytes] >> (0x7 - (bitOffset & 0x7))) & 0x1;
  }

  private readBits(buf: Uint8Array, readBits: number): number {
    let tmp = 0;
    if (readBits === 1) {
      tmp = this.getBit(buf, 0);
    } else {
      for (let i = 0; i < readBits; i++) {
        const tmp2 = this.getBit(buf, i);
        tmp = (tmp << 1) + tmp2;
      }
    }
    this.bitCount += readBits;
    return tmp;
  }

  private ue(base: Uint8Array, offset: number): number {
    let zeros = 0;
    let tmp = 0;
    let ret = 0;
    let idx = offset;
    do {
      tmp = this.getBit(base, idx++);
      if (tmp === 0) zeros++;
    } while (tmp === 0);

    if (zeros === 0) {
      this.bitCount += 1;
      return 0;
    }

    ret = 1 << zeros;
    for (let i = zeros - 1; i >= 0; i--, idx++) {
      tmp = this.getBit(base, idx);
      ret |= tmp << i;
    }
    this.bitCount += zeros * 2 + 1;
    return ret - 1;
  }

  parse(spsPayload: Uint8Array): boolean {
    this.spsBytes = this.nalUnitExtractRbsp(spsPayload);
    const spsBytes = this.spsBytes;
    this.bitCount = 0;
    this.spsMap.clear();

    // 7.3.1.2 NAL unit header syntax
    this.spsMap.put('forbidden_zero_bit', this.readBits(spsBytes, 1));
    this.spsMap.put('nal_unit_type', this.readBits(spsBytes, 6));
    this.spsMap.put('nuh_layer_id', this.readBits(spsBytes, 6));
    this.spsMap.put('nuh_temporal_id_plus1', this.readBits(spsBytes, 3));

    // 7.3.2.2.1 General sequence parameter set RBSP syntax
    this.spsMap.put('sps_video_parameter_set_id', this.readBits(spsBytes, 4));
    this.spsMap.put('sps_max_sub_layers_minus1', this.readBits(spsBytes, 3));
    this.spsMap.put('sps_temporal_id_nesting_flag', this.readBits(spsBytes, 1));

    this.spsMap.put('general_profile_space', this.readBits(spsBytes, 2));
    this.spsMap.put('general_tier_flag', this.readBits(spsBytes, 1));
    this.spsMap.put('general_profile_idc', this.readBits(spsBytes, 5));
    this.spsMap.put('general_profile_compatibility_flags', this.readBits(spsBytes, 32));
    this.spsMap.put('general_constraint_indicator_flags', [
      this.readBits(spsBytes, 16),
      this.readBits(spsBytes, 16),
      this.readBits(spsBytes, 16)
    ]);
    this.spsMap.put('general_level_idc', this.readBits(spsBytes, 8));

    this.spsMap.put('sps_seq_parameter_set_id', this.ue(spsBytes, 0));

    this.spsMap.put('chroma_format_idc', this.ue(spsBytes, 0));
    if (this.spsMap.get('chroma_format_idc') === 3) {
      this.spsMap.put('separate_colour_plane_flag', this.readBits(spsBytes, 1));
    }

    this.spsMap.put('pic_width_in_luma_samples', this.ue(spsBytes, 0));
    this.spsMap.put('pic_height_in_luma_samples', this.ue(spsBytes, 0));

    this.spsMap.put('conformance_window_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('conformance_window_flag') === 1) {
      this.spsMap.put('conf_win_left_offset', this.ue(spsBytes, 0));
      this.spsMap.put('conf_win_right_offset', this.ue(spsBytes, 0));
      this.spsMap.put('conf_win_top_offset', this.ue(spsBytes, 0));
      this.spsMap.put('conf_win_bottom_offset', this.ue(spsBytes, 0));
    }

    return true;
  }

  getSizeInfo(): SpsSizeInfo {
    const width0 = this.spsMap.get('pic_width_in_luma_samples') as number;
    const height0 = this.spsMap.get('pic_height_in_luma_samples') as number;

    let subWidthC = 2;
    let subHeightC = 2;
    const chromaFormatIdc = this.spsMap.get('chroma_format_idc');
    const separateColourPlaneFlag = this.spsMap.get('separate_colour_plane_flag');

    if (chromaFormatIdc === 0) {
      subWidthC = subHeightC = 1;
    } else if (chromaFormatIdc === 1) {
      subWidthC = 2;
      subHeightC = 2;
    } else if (chromaFormatIdc === 2) {
      subWidthC = 2;
      subHeightC = 1;
    } else if (chromaFormatIdc === 3) {
      if (separateColourPlaneFlag === 0) {
        subWidthC = subHeightC = 1;
      } else if (separateColourPlaneFlag === 1) {
        subWidthC = subHeightC = 1;
      }
    }

    let cropWidth = 0;
    let cropHeight = 0;
    if (this.spsMap.get('conformance_window_flag') === 1) {
      cropWidth =
        subWidthC * (this.spsMap.get('conf_win_right_offset') as number) +
        subWidthC * (this.spsMap.get('conf_win_left_offset') as number);
      cropHeight =
        subHeightC * (this.spsMap.get('conf_win_bottom_offset') as number) +
        subHeightC * (this.spsMap.get('conf_win_top_offset') as number);
    }

    let width = width0;
    let height = height0;
    if (cropWidth) {
      width -= cropWidth;
    }
    if (cropHeight) {
      height -= cropHeight;
    }

    const decodeSize = width * height;
    return { width, height, decodeSize, cropWidth, cropHeight };
  }

  getSpsValue(key: string): SpsValue {
    return this.spsMap.get(key);
  }

  getProfileName(): string {
    const profile = this.spsMap.get('general_profile_idc');
    switch (profile) {
      case 1:
        return 'Main';
      case 2:
        return 'Main 10';
      case 3:
        return 'Main Still Picture';
      case 4:
        return 'Rext';
      default:
        return 'Unknown';
    }
  }

  getCodecInfo(): string {
    const coding = 'hvc1';
    let profileSpaceLabel: string;
    const profileSpace = this.spsMap.get('general_profile_space') as number;
    if (profileSpace > 0 && profileSpace <= 3) {
      profileSpaceLabel = 'A' + (profileSpace - 1);
    } else {
      profileSpaceLabel = '';
    }
    const profileIdc = this.spsMap.get('general_profile_idc') as number;
    const constraintFlags = this.spsMap.get('general_constraint_indicator_flags') as number[];
    let constraints = constraintFlags[0];
    while (constraints && (constraints & 0xff) === 0) {
      constraints >>= 8;
    }

    return (
      coding +
      '.' +
      profileSpaceLabel +
      profileIdc +
      '.' +
      reverseBits(this.spsMap.get('general_profile_compatibility_flags') as number, 32) +
      '.' +
      (this.spsMap.get('general_tier_flag') ? 'H' : 'L') +
      this.spsMap.get('general_level_idc') +
      '.' +
      constraints.toString(16)
    );
  }

  getProfileTierLevel(): number[] {
    const compatibilityFlags = this.spsMap.get('general_profile_compatibility_flags') as number;
    const constraintFlags = this.spsMap.get('general_constraint_indicator_flags') as number[];

    return [
      ((this.spsMap.get('general_profile_space') as number) << 6) |
        ((this.spsMap.get('general_tier_flag') as number) << 5) |
        (this.spsMap.get('general_profile_idc') as number),
      (compatibilityFlags & 0xff000000) >> 24,
      (compatibilityFlags & 0xff0000) >> 16,
      (compatibilityFlags & 0xff00) >> 8,
      compatibilityFlags & 0xff,
      (constraintFlags[0] & 0xff00) >> 8,
      constraintFlags[0] & 0xff,
      (constraintFlags[1] & 0xff00) >> 8,
      constraintFlags[1] & 0xff,
      (constraintFlags[2] & 0xff00) >> 8,
      constraintFlags[2] & 0xff,
      this.spsMap.get('general_level_idc') as number
    ];
  }
}
