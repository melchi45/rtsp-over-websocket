import { RTSPOverWebSocketMap } from './RTSPOverWebSocketMap';

export interface SpsSizeInfo {
  width: number;
  height: number;
  decodeSize: number;
  cropWidth: number;
  cropHeight: number;
}

type SpsValue = number | number[] | undefined;

/** Ported from the legacy player’s Util/h264SPSParser.js. */
export class H264SPSParser {
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

    if (base.length !== idx) {
      do {
        tmp = this.getBit(base, idx++);
        if (tmp === 0) {
          zeros++;
        }
        if (base.length === idx) {
          break;
        }
      } while (tmp === 0);
    }

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

  private se(base: Uint8Array, offset: number): number {
    const ret = this.ue(base, offset);
    return ret & 0x1 ? (ret + 1) / 2 : -ret / 2;
  }

  private hrdParameters(spsBytes: Uint8Array): void {
    this.spsMap.put('cpb_cnt_minus1', this.ue(spsBytes, 0));
    this.spsMap.put('bit_rate_scale', this.readBits(spsBytes, 4));
    this.spsMap.put('cpb_size_scale', this.readBits(spsBytes, 4));
    const cpbCntMinus1 = this.spsMap.get('cpb_cnt_minus1') as number;
    const bitRateValueMinus1 = new Array(cpbCntMinus1);
    const cpbSizeValueMinus1 = new Array(cpbCntMinus1);
    const cbrFlag = new Array(cpbCntMinus1);
    for (let i = 0; i <= cpbCntMinus1; i++) {
      bitRateValueMinus1[i] = this.ue(spsBytes, 0);
      cpbSizeValueMinus1[i] = this.ue(spsBytes, 0);
      cbrFlag[i] = this.readBits(spsBytes, 1);
    }
    this.spsMap.put('bit_rate_value_minus1', bitRateValueMinus1);
    this.spsMap.put('cpb_size_value_minus1', cpbSizeValueMinus1);
    this.spsMap.put('cbr_flag', cbrFlag);

    this.spsMap.put('initial_cpb_removal_delay_length_minus1', this.readBits(spsBytes, 5));
    this.spsMap.put('cpb_removal_delay_length_minus1', this.readBits(spsBytes, 5));
    this.spsMap.put('dpb_output_delay_length_minus1', this.readBits(spsBytes, 5));
    this.spsMap.put('time_offset_length', this.readBits(spsBytes, 5));
  }

  private vuiParameters(spsBytes: Uint8Array): void {
    this.spsMap.put('aspect_ratio_info_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('aspect_ratio_info_present_flag')) {
      this.spsMap.put('aspect_ratio_idc', this.readBits(spsBytes, 8));
      if (this.spsMap.get('aspect_ratio_idc') === 255) {
        this.spsMap.put('sar_width', this.readBits(spsBytes, 16));
        this.spsMap.put('sar_height', this.readBits(spsBytes, 16));
      }
    }

    this.spsMap.put('overscan_info_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('overscan_info_present_flag')) {
      this.spsMap.put('overscan_appropriate_flag', this.readBits(spsBytes, 1));
    }
    this.spsMap.put('video_signal_type_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('video_signal_type_present_flag')) {
      this.spsMap.put('video_format', this.readBits(spsBytes, 3));
      this.spsMap.put('video_full_range_flag', this.readBits(spsBytes, 1));
      this.spsMap.put('colour_description_present_flag', this.readBits(spsBytes, 1));
      if (this.spsMap.get('colour_description_present_flag')) {
        this.spsMap.put('colour_primaries', this.readBits(spsBytes, 8));
        this.spsMap.put('transfer_characteristics', this.readBits(spsBytes, 8));
        this.spsMap.put('matrix_coefficients', this.readBits(spsBytes, 8));
      }
    }
    this.spsMap.put('chroma_loc_info_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('chroma_loc_info_present_flag')) {
      this.spsMap.put('chroma_sample_loc_type_top_field', this.ue(spsBytes, 0));
      this.spsMap.put('chroma_sample_loc_type_bottom_field', this.ue(spsBytes, 0));
    }
    this.spsMap.put('timing_info_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('timing_info_present_flag')) {
      this.spsMap.put('num_units_in_tick', this.readBits(spsBytes, 32));
      this.spsMap.put('time_scale', this.readBits(spsBytes, 32));
      this.spsMap.put('fixed_frame_rate_flag', this.readBits(spsBytes, 1));
    }
    this.spsMap.put('nal_hrd_parameters_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('nal_hrd_parameters_present_flag')) {
      this.hrdParameters(spsBytes);
    }
    this.spsMap.put('vcl_hrd_parameters_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('vcl_hrd_parameters_present_flag')) {
      this.hrdParameters(spsBytes);
    }
    if (this.spsMap.get('nal_hrd_parameters_present_flag') || this.spsMap.get('vcl_hrd_parameters_present_flag')) {
      this.spsMap.put('low_delay_hrd_flag', this.readBits(spsBytes, 1));
    }
    this.spsMap.put('pic_struct_present_flag', this.readBits(spsBytes, 1));
    this.spsMap.put('bitstream_restriction_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('bitstream_restriction_flag')) {
      this.spsMap.put('motion_vectors_over_pic_boundaries_flag', this.readBits(spsBytes, 1));
      this.spsMap.put('max_bytes_per_pic_denom', this.ue(spsBytes, 0));
      this.spsMap.put('max_bits_per_mb_denom', this.ue(spsBytes, 0));
      this.spsMap.put('log2_max_mv_length_horizontal', this.ue(spsBytes, 0));
      this.spsMap.put('log2_max_mv_length_vertical', this.ue(spsBytes, 0));
      this.spsMap.put('max_num_reorder_frames', this.ue(spsBytes, 0));
      this.spsMap.put('max_dec_frame_buffering', this.ue(spsBytes, 0));
    }
  }

  parse(spsPayload: Uint8Array): boolean {
    this.spsBytes = this.nalUnitExtractRbsp(spsPayload);
    const spsBytes = this.spsBytes;
    this.bitCount = 0;
    this.spsMap.clear();

    this.spsMap.put('forbidden_zero_bit', this.readBits(spsBytes, 1));
    this.spsMap.put('nal_ref_idc', this.readBits(spsBytes, 2));
    this.spsMap.put('nal_unit_type', this.readBits(spsBytes, 5));

    this.spsMap.put('profile_idc', this.readBits(spsBytes, 8));
    this.spsMap.put('profile_compatibility', this.readBits(spsBytes, 8));
    this.spsMap.put('level_idc', this.readBits(spsBytes, 8));

    this.spsMap.put('seq_parameter_set_id', this.ue(spsBytes, 0));

    const profileIdc = this.spsMap.get('profile_idc') as number;
    this.spsMap.put('chroma_format_idc', 0);
    if (
      [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)
    ) {
      this.spsMap.put('chroma_format_idc', this.ue(spsBytes, 0));
      if (this.spsMap.get('chroma_format_idc') === 3) {
        this.spsMap.put('separate_colour_plane_flag', this.readBits(spsBytes, 1));
      }

      let chromaArrayType = 0;
      const chromaFormatIdc = this.spsMap.get('chroma_format_idc') as number;
      if (this.spsMap.get('separate_colour_plane_flag') === 0) {
        chromaArrayType = chromaFormatIdc;
      } else if (this.spsMap.get('separate_colour_plane_flag') === 1) {
        chromaArrayType = 0;
      }
      this.spsMap.put('ChromaArrayType', chromaArrayType);

      this.spsMap.put('bit_depth_luma_minus8', this.ue(spsBytes, 0));
      this.spsMap.put('bit_depth_chroma_minus8', this.ue(spsBytes, 0));
      this.spsMap.put('qpprime_y_zero_transform_bypass_flag', this.readBits(spsBytes, 1));
      this.spsMap.put('seq_scaling_matrix_present_flag', this.readBits(spsBytes, 1));

      if (this.spsMap.get('seq_scaling_matrix_present_flag')) {
        const num = this.spsMap.get('chroma_format_idc') !== 3 ? 8 : 12;
        const seqScalingListPresentFlag = new Array(num);
        for (let i = 0; i < num; i++) {
          seqScalingListPresentFlag[i] = this.readBits(spsBytes, 1);
          if (seqScalingListPresentFlag[i]) {
            const slN = i < 6 ? 16 : 64;
            let lastScale = 8;
            let nextScale = 8;
            const scalingList = new Array(slN);
            for (let j = 0; j < slN; j++) {
              if (nextScale) {
                const deltaScale = this.se(spsBytes, 0);
                nextScale = (lastScale + deltaScale + 256) % 256;
              }
              scalingList[j] = nextScale === 0 ? lastScale : nextScale;
              lastScale = scalingList[j];
            }
          }
        }
        this.spsMap.put('seq_scaling_list_present_flag', seqScalingListPresentFlag);
      }
    }
    this.spsMap.put('log2_max_frame_num_minus4', this.ue(spsBytes, 0));
    this.spsMap.put('pic_order_cnt_type', this.ue(spsBytes, 0));

    if (this.spsMap.get('pic_order_cnt_type') === 0) {
      this.spsMap.put('log2_max_pic_order_cnt_lsb_minus4', this.ue(spsBytes, 0));
    } else if (this.spsMap.get('pic_order_cnt_type') === 1) {
      this.spsMap.put('delta_pic_order_always_zero_flag', this.readBits(spsBytes, 1));
      this.spsMap.put('offset_for_non_ref_pic', this.se(spsBytes, 0));
      this.spsMap.put('offset_for_top_to_bottom_field', this.se(spsBytes, 0));
      this.spsMap.put('num_ref_frames_in_pic_order_cnt_cycle', this.ue(spsBytes, 0));
      const numRefFrames = this.spsMap.get('num_ref_frames_in_pic_order_cnt_cycle') as number;
      for (let i = 0; i < numRefFrames; i++) {
        this.se(spsBytes, 0);
      }
    }
    this.spsMap.put('num_ref_frames', this.ue(spsBytes, 0));
    this.spsMap.put('gaps_in_frame_num_value_allowed_flag', this.readBits(spsBytes, 1));
    this.spsMap.put('pic_width_in_mbs_minus1', this.ue(spsBytes, 0));
    this.spsMap.put('pic_height_in_map_units_minus1', this.ue(spsBytes, 0));
    this.spsMap.put('frame_mbs_only_flag', this.readBits(spsBytes, 1));

    if (this.spsMap.get('frame_mbs_only_flag') === 0) {
      this.spsMap.put('mb_adaptive_frame_field_flag', this.readBits(spsBytes, 1));
    }
    this.spsMap.put('direct_8x8_interence_flag', this.readBits(spsBytes, 1));

    this.spsMap.put('frame_cropping_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('frame_cropping_flag') === 1) {
      this.spsMap.put('frame_cropping_rect_left_offset', this.ue(spsBytes, 0));
      this.spsMap.put('frame_cropping_rect_right_offset', this.ue(spsBytes, 0));
      this.spsMap.put('frame_cropping_rect_top_offset', this.ue(spsBytes, 0));
      this.spsMap.put('frame_cropping_rect_bottom_offset', this.ue(spsBytes, 0));
    }

    this.spsMap.put('vui_parameters_present_flag', this.readBits(spsBytes, 1));
    if (this.spsMap.get('vui_parameters_present_flag')) {
      this.vuiParameters(spsBytes);
    }

    return true;
  }

  getSizeInfo(): SpsSizeInfo {
    const macroblockSamples = 16;
    let subWidthC = 2;
    let subHeightC = 2;

    const chromaFormatIdc = this.spsMap.get('chroma_format_idc');
    const separateColourPlaneFlag = this.spsMap.get('separate_colour_plane_flag');

    if (chromaFormatIdc === 0 && separateColourPlaneFlag === 0) {
      subWidthC = subHeightC = 0;
    } else if (chromaFormatIdc === 1 && separateColourPlaneFlag === 0) {
      subWidthC = subHeightC = 2;
    } else if (chromaFormatIdc === 2 && separateColourPlaneFlag === 0) {
      subWidthC = 2;
      subHeightC = 1;
    } else if (chromaFormatIdc === 3) {
      if (separateColourPlaneFlag === 0) {
        subWidthC = subHeightC = 1;
      } else if (separateColourPlaneFlag === 1) {
        subWidthC = subHeightC = 0;
      }
    }

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;

    if (this.spsMap.get('frame_cropping_flag') === 1) {
      cropLeft = this.spsMap.get('frame_cropping_rect_left_offset') as number;
      cropRight = this.spsMap.get('frame_cropping_rect_right_offset') as number;
      cropTop = this.spsMap.get('frame_cropping_rect_top_offset') as number;
      cropBottom = this.spsMap.get('frame_cropping_rect_bottom_offset') as number;
    }

    const picWidthInMbs = (this.spsMap.get('pic_width_in_mbs_minus1') as number) + 1;
    const picHeightInMapUnits = (this.spsMap.get('pic_height_in_map_units_minus1') as number) + 1;
    const frameHeightInMbs = (2 - (this.spsMap.get('frame_mbs_only_flag') as number)) * picHeightInMapUnits;

    const cropUnitX = subWidthC;
    const cropUnitY = subHeightC * (2 - (this.spsMap.get('frame_mbs_only_flag') as number));

    let width = picWidthInMbs * macroblockSamples;
    let height = frameHeightInMbs * macroblockSamples;

    const cropWidth = cropUnitX * (cropLeft + cropRight);
    const cropHeight = cropUnitY * (cropTop + cropBottom);

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

  getCodecInfo(): string | null {
    let profileIdc = this.spsMap.get('profile_idc') as number;
    let profileCompatibility = this.spsMap.get('profile_compatibility') as number;
    let levelIdc = this.spsMap.get('level_idc') as number;

    if (typeof profileIdc === 'undefined' || typeof profileCompatibility === 'undefined' || typeof levelIdc === 'undefined') {
      return null;
    }

    const profileIdcHex = (profileIdc <= 0x0f ? '0' : '') + profileIdc.toString(16);
    const profileCompatibilityHex = (profileCompatibility <= 0x0f ? '0' : '') + profileCompatibility.toString(16);
    const levelIdcHex = (levelIdc <= 0x0f ? '0' : '') + levelIdc.toString(16);

    return 'avc1.' + profileIdcHex + profileCompatibilityHex + levelIdcHex;
  }
}
