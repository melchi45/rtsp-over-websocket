//'use strict';
/**
* mux.js
*
* Copyright (c) 2015 Brightcove
* All rights reserved.
*
* Functions that generate fragmented MP4s suitable for use with Media
* Source Extensions.
*/
var box, dinf, dOps, esds, ftyp, mdat, mfhd, minf, moof, moov, mvex, mvhd,
  trak, tkhd, mdia, mdhd, hdlr, sdtp, stbl, stsd, traf, trex,
  trun, types, MAJOR_BRAND, MINOR_VERSION, AVC1_BRAND, VIDEO_HDLR,
  ISO2_BRAND, ISO5_BRAND, DASH_BRAND, MP41_BRAND, iods, mehd, trep,
  free, udta, meta, ilst, styp, sidx, vpcC, av1C,
  AUDIO_HDLR, HDLR_TYPES, VMHD, SMHD, DREF, STCO, STSC, STSZ, STTS;

var arr = [];
// pre-calculate constants
(function () {
  var i;
  types = {
    avc1: [], // codingname
    avcC: [],
    hvc1: [],
    hvcC: [],
    vp08: [], // codingname (VP8 — never used as a stsd entry type today, see videoSample(); kept for FourCC-table uniformity)
    vp09: [], // codingname
    vpcC: [],
    av01: [], // codingname
    av1C: [],
    btrt: [],
    dinf: [],
    dref: [],
    esds: [],
    ftyp: [],
    hdlr: [],
    mdat: [],
    mdhd: [],
    mdia: [],
    mfhd: [],
    minf: [],
    moof: [],
    moov: [],
    mp4a: [], // codingname
    mp4v: [], // MJPEG
    Opus: [], // codingname (Opus, capitalized per "Opus in ISOBMFF")
    dOps: [],
    mvex: [],
    mvhd: [],
    iods: [],
    sdtp: [],
    smhd: [],
    stbl: [],
    stco: [],
    stsc: [],
    stsd: [],
    stsz: [],
    stts: [],
    styp: [],
    tfdt: [],
    tfhd: [],
    traf: [],
    trak: [],
    trun: [],
    trex: [],
    trep: [],
    mehd: [],
    tkhd: [],
    vmhd: [],
    udta: [],
    meta: [],
    ilst: [],
    free: [],
    sidx: []
  };

  // In environments where Uint8Array is undefined (e.g., IE8), skip set up so that we
  // don't throw an error
  if (typeof Uint8Array === 'undefined') {
    return;
  }

  for (i in types) {
    if (types.hasOwnProperty(i)) {
      types[i] = [
        i.charCodeAt(0),
        i.charCodeAt(1),
        i.charCodeAt(2),
        i.charCodeAt(3)
      ];
    }
  }

  MAJOR_BRAND = new Uint8Array([
    'i'.charCodeAt(0),
    's'.charCodeAt(0),
    'o'.charCodeAt(0),
    'm'.charCodeAt(0)
  ]);
  AVC1_BRAND = new Uint8Array([
    'a'.charCodeAt(0),
    'v'.charCodeAt(0),
    'c'.charCodeAt(0),
    '1'.charCodeAt(0)
  ]);
  ISO2_BRAND = new Uint8Array([
    'i'.charCodeAt(0),
    's'.charCodeAt(0),
    'o'.charCodeAt(0),
    '2'.charCodeAt(0)
  ]);
  ISO5_BRAND = new Uint8Array([
    'i'.charCodeAt(0),
    's'.charCodeAt(0),
    'o'.charCodeAt(0),
    '5'.charCodeAt(0)
  ]);
  DASH_BRAND = new Uint8Array([
    'd'.charCodeAt(0),
    'a'.charCodeAt(0),
    's'.charCodeAt(0),
    'h'.charCodeAt(0)
  ]);
  MP41_BRAND = new Uint8Array([
    'm'.charCodeAt(0),
    'p'.charCodeAt(0),
    '4'.charCodeAt(0),
    '1'.charCodeAt(0)
  ]);
  MINOR_VERSION = new Uint8Array([0, 0, 0, 1]);
  VIDEO_HDLR = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x76, 0x69, 0x64, 0x65, // handler_type: 'vide'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x55, 0x57, 0x41, 0x5F,
    0x36, 0x30, 0x30, 0x70,
    0x5F, 0x33, 0x30, 0x66,
    0x70, 0x73, 0x2E, 0x68,
    0x32, 0x36, 0x34, 0x00
  ]);
  AUDIO_HDLR = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // pre_defined
    0x73, 0x6f, 0x75, 0x6e, // handler_type: 'soun'
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00, // reserved
    0x53, 0x6f, 0x75, 0x6e,
    0x64, 0x48, 0x61, 0x6e,
    0x64, 0x6c, 0x65, 0x72, 0x00 // name: 'SoundHandler'
  ]);
  HDLR_TYPES = {
    video: VIDEO_HDLR,
    audio: AUDIO_HDLR
  };
  DREF = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x01, // entry_count
    0x00, 0x00, 0x00, 0x0c, // entry_size
    0x75, 0x72, 0x6c, 0x20, // 'url' type
    0x00, // version 0
    0x00, 0x00, 0x01 // entry_flags
  ]);
  SMHD = new Uint8Array([
    0x00,             // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00,       // balance, 0 means centered
    0x00, 0x00        // reserved
  ]);
  STCO = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00 // entry_count
  ]);
  STSC = STCO;
  STSZ = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags
    0x00, 0x00, 0x00, 0x00, // sample_size
    0x00, 0x00, 0x00, 0x00 // sample_count
  ]);
  STTS = STCO;
  VMHD = new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x01, // flags
    0x00, 0x00, // graphicsmode
    0x00, 0x00,
    0x00, 0x00,
    0x00, 0x00 // opcolor
  ]);
}());

box = function (type) {
  var
    payload = [],
    size = 0,
    i,
    result,
    view;

  for (i = 1; i < arguments.length; i++) {
    payload.push(arguments[i]);
  }

  i = payload.length;

  // calculate the total size we need to allocate
  while (i--) {
    size += payload[i].byteLength;
  }
  result = new Uint8Array(size + 8);
  view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, result.byteLength);
  result.set(type, 4);

  // copy the payload into the result
  for (i = 0, size = 8; i < payload.length; i++) {
    result.set(payload[i], size);
    size += payload[i].byteLength;
  }
  return result;
};

dinf = function () {
  return box(types.dinf, box(types.dref, DREF));
};

esds = function (track) {
  return box(types.esds, new Uint8Array( track.codecType === "MJPEG" ? [
    0x00, // version
    0x00, 0x00, 0x00, // flags

    // ES_Descriptor
    0x03, // tag, ES_DescrTag
    0x15, // length
    0x00, 0x00, // ES_ID
    0x00, // streamDependenceFlag, URL_flag, reserved, streamPriority

    // DecoderConfigDescriptor
    0x04, // tag, DecoderConfigDescrTag
    0x0D, // length
    0x6C, // object type
    0x11,  // streamType
    0x00, 0x06, 0x00, // bufferSizeDB
    0x00, 0x00, 0x00, 0x00, // maxBitrate
    0x00, 0x00, 0x00, 0x00, // avgBitrate
    0x06, 0x01, 0x02 // GASpecificConfig
  ] : [
    0x00, // version
    0x00, 0x00, 0x00, // flags

    // ES_Descriptor
    0x03, // tag, ES_DescrTag
    0x19, // length
    0x00, 0x00, // ES_ID
    0x00, // streamDependenceFlag, URL_flag, reserved, streamPriority

    // DecoderConfigDescriptor
    0x04, // tag, DecoderConfigDescrTag
    0x11, // length
    0x40, // object type
    0x15,  // streamType
    0x00, 0x06, 0x00, // bufferSizeDB
    0x00, 0x00, 0x00, 0x00, // maxBitrate
    0x00, 0x00, 0x00, 0x00, // avgBitrate

    // DecoderSpecificInfo
    0x05, // tag, DecoderSpecificInfoTag
    0x02, // length
    // ISO/IEC 14496-3, AudioSpecificConfig
    // for samplingFrequencyIndex see ISO/IEC 13818-7:2006, 8.1.3.2.2, Table 35
    (track.audioobjecttype << 3) | (track.samplingfrequencyindex >>> 1),
    (track.samplingfrequencyindex << 7) | (track.channelcount << 3),
    0x06, 0x01, 0x02 // GASpecificConfig
  ]));
};

// OpusSpecificBox ("dOps"), per "Encapsulation of Opus in ISO Base Media
// File Format", version 0. ChannelMappingFamily is hardcoded to 0 (simple
// mono/stereo, no extra ChannelMappingTable needed) since track.channelcount
// here is always 1 or 2 — see OPUSAudioDecoder.ts's comment on why this
// player currently only ever decodes Opus as mono. PreSkip is 0: that field
// describes encoder-priming samples to discard, sourced from the original
// Ogg Opus header, which RTP-transported Opus (RFC 7587) has no equivalent
// of — 0 is the simplest safe value or the alternative. InputSampleRate is
// hardcoded to 48000 per RFC 7587 §4.1 (Opus-over-RTP's fixed clock rate).
dOps = function (track) {
  return box(types.dOps, new Uint8Array([
    0x00, // Version
    track.channelcount & 0xff, // OutputChannelCount
    0x00, 0x00, // PreSkip
    (48000 >>> 24) & 0xff,
    (48000 >>> 16) & 0xff,
    (48000 >>> 8) & 0xff,
    48000 & 0xff, // InputSampleRate
    0x00, 0x00, // OutputGain
    0x00 // ChannelMappingFamily
  ]));
};

ftyp = function () {
  return box(types.ftyp, MAJOR_BRAND, MINOR_VERSION, AVC1_BRAND, MP41_BRAND, ISO5_BRAND, DASH_BRAND);
};

// Shared 78-byte VisualSampleEntry header (ISO/IEC 14496-12 §12.1.3) — byte-
// identical shape across avc1/hvc1/vp09/av01, only width/height vary. Kept
// as its own helper instead of copy-pasting a 4th ~78-byte literal.
function visualSampleEntry(width, height) {
  return new Uint8Array([
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, // reserved
    0x00, 0x01, // data_reference_index
    0x00, 0x00, // pre_defined
    0x00, 0x00, // reserved
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // pre_defined
    (width & 0xff00) >> 8,
    width & 0xff, // width
    (height & 0xff00) >> 8,
    height & 0xff, // height
    0x00, 0x48, 0x00, 0x00, // horizresolution
    0x00, 0x48, 0x00, 0x00, // vertresolution
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x01, // frame_count
    0x13,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, // compressorname
    0x00, 0x18, // depth = 24
    0x11, 0x11 // pre_defined = -1
  ]);
}

// VP Codec ISO Media File Format Binding, VPCodecConfigurationRecord
// (https://github.com/webmproject/vp9-dash — chromaSubsampling enum
// confirmed there: 0=4:2:0 vertical, 1=4:2:0 colocated with luma (0,0),
// 2=4:2:2, 3=4:4:4). `level` is always 0 ("unspecified") — VP9's own
// bitstream has no per-keyframe level field to source it from.
//
// colourPrimaries/transferCharacteristics/matrixCoefficients: the binding
// spec only says these follow ISO/IEC 23001-8 (CICP/H.273) without giving a
// VP9-`color_space`-to-CICP table of its own. The mapping below follows the
// same convention ffmpeg's VP9 decoder uses (libavcodec/vp9.c's per-
// color_space AVColorSpace table, whose values are themselves CICP matrix-
// coefficients codes) — a de facto ecosystem convention, not a value this
// player's decode correctness depends on (the elementary VP9 bitstream is
// self-describing; these three fields are colour-management metadata only).
var VP9_CICP_COLOR_CONFIG = [
  { primaries: 2, transfer: 2, matrix: 2 }, // 0 CS_UNKNOWN -> unspecified
  { primaries: 5, transfer: 5, matrix: 5 }, // 1 CS_BT_601 -> BT.470BG
  { primaries: 1, transfer: 1, matrix: 1 }, // 2 CS_BT_709
  { primaries: 6, transfer: 6, matrix: 6 }, // 3 CS_SMPTE_170
  { primaries: 7, transfer: 7, matrix: 7 }, // 4 CS_SMPTE_240
  { primaries: 9, transfer: 14, matrix: 9 }, // 5 CS_BT_2020
  { primaries: 2, transfer: 2, matrix: 2 }, // 6 CS_RESERVED -> unspecified fallback
  { primaries: 1, transfer: 13, matrix: 0 } // 7 CS_RGB -> BT.709 primaries + sRGB transfer + Identity matrix
];

function vp9ChromaSubsampling(subsamplingX, subsamplingY) {
  if (subsamplingX === 1 && subsamplingY === 1) {
    return 1; // 4:2:0 colocated — VP9's own convention (no separate chroma_sample_position field to distinguish "vertical")
  }
  if (subsamplingX === 1 && subsamplingY === 0) {
    return 2; // 4:2:2
  }
  return 3; // 4:4:4 (0,0)
}

vpcC = function (track) {
  var colorConfig = VP9_CICP_COLOR_CONFIG[track.colorSpace] || VP9_CICP_COLOR_CONFIG[0];
  var chromaSubsampling = vp9ChromaSubsampling(track.subsamplingX, track.subsamplingY);
  return box(types.vpcC, new Uint8Array([
    0x01, // version
    0x00, 0x00, 0x00, // flags
    track.profile, // profile
    0x00, // level (unspecified — VP9 has no per-keyframe level field)
    ((track.bitDepth & 0x0f) << 4) | ((chromaSubsampling & 0x07) << 1) | (track.colorRange & 0x01),
    colorConfig.primaries,
    colorConfig.transfer,
    colorConfig.matrix,
    0x00, 0x00 // codecIntializationDataSize = 0 (no codecIntializationData)
  ]));
};

// AV1 Codec ISO Media File Format Binding, AV1CodecConfigurationRecord
// (https://aomediacodec.github.io/av1-isobmff/ §2.3.3 — confirmed field
// layout: marker(1)=1/version(7)=1, seq_profile(3)/seq_level_idx_0(5),
// seq_tier_0(1)/high_bitdepth(1)/twelve_bit(1)/monochrome(1)/
// chroma_subsampling_x(1)/chroma_subsampling_y(1)/chroma_sample_position(2),
// reserved(3)=0/initial_presentation_delay_present(1)=0/reserved(4)=0, then
// configOBUs = the verbatim Sequence Header OBU bytes (not a from-scratch
// re-serialization) — `track.configObu` is that raw byte range, sourced
// from `AV1HeaderParser.parseAV1SequenceHeader`'s returned obuStart/obuEnd.
// Not a FullBox — the marker/version pair plays that role at the record
// level instead of a box-level version/flags.
av1C = function (track) {
  var configObu = track.configObu || new Uint8Array(0);
  var header = new Uint8Array([
    0x81, // marker(1)=1, version(7)=1
    ((track.profile & 0x07) << 5) | (track.seqLevelIdx0 & 0x1f),
    (((track.seqTier0 & 0x01) << 7) |
      ((track.highBitdepth & 0x01) << 6) |
      ((track.twelveBit & 0x01) << 5) |
      ((track.monoChrome & 0x01) << 4) |
      ((track.chromaSubsamplingX & 0x01) << 3) |
      ((track.chromaSubsamplingY & 0x01) << 2) |
      (track.chromaSamplePosition & 0x03)),
    0x00 // reserved(3)=0, initial_presentation_delay_present(1)=0, reserved(4)=0
  ]);
  var payload = new Uint8Array(header.length + configObu.length);
  payload.set(header, 0);
  payload.set(configObu, header.length);
  return box(types.av1C, payload);
};

hdlr = function (type) {
  if (type === undefined) {
    var
      bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x6D, 0x64, 0x69, 0x72,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00
      ]);
    return box(types.hdlr, bytes);
  } else {
    return box(types.hdlr, HDLR_TYPES[type]);
  }
};
mdat = function (data) {
  return box(types.mdat, data);
};
mdhd = function (track) {
  var result = new Uint8Array([
    0x00,                   // version 0
    0x00, 0x00, 0x00,       // flags
    0x00, 0x00, 0x00, 0x02, // creation_time
    0x00, 0x00, 0x00, 0x03, // modification_time
    0x00, 0x00, 0x27, 0x10, // timescale, 10000 "ticks" per second
    (track.duration >>> 24) & 0xFF,
    (track.duration >>> 16) & 0xFF,
    (track.duration >>> 8) & 0xFF,
    track.duration & 0xFF,
    0x55, 0xc4, // 'und' language (undetermined)
    0x00, 0x00
  ]);

  // Use the sample rate from the track metadata, when it is
  // defined. The sample rate can be parsed out of an ADTS header, for
  // instance.
  if (track.samplerate) {
    result[12] = (track.samplerate >>> 24) & 0xFF;
    result[13] = (track.samplerate >>> 16) & 0xFF;
    result[14] = (track.samplerate >>> 8) & 0xFF;
    result[15] = (track.samplerate) & 0xFF;
  }

  return box(types.mdhd, result);
};
mdia = function (track) {
  return box(types.mdia, mdhd(track), hdlr(track.type), minf(track));
};
mfhd = function (sequenceNumber) {
  return box(types.mfhd, new Uint8Array([
    0x00, // version
    0x00, 0x00, 0x00, // flags
    (sequenceNumber & 0xFF000000) >> 24,
    (sequenceNumber & 0xFF0000) >> 16,
    (sequenceNumber & 0xFF00) >> 8,
    sequenceNumber & 0xFF // sequence_number
  ]));
};
minf = function (track) {
  return box(types.minf,
    track.type === 'video' ? box(types.vmhd, VMHD) : box(types.smhd, SMHD),
    dinf(),
    stbl(track));
};
moof = function (sequenceNumber, tracks, dataLens) {
  var
    trackFragments = [],
    i = tracks.length;
    // moreOffset = 0;
  // build traf boxes for each track fragment
  while (i--) {
    trackFragments[i] = traf(tracks[i], 0);
  }
  // while (i--) { // all existing offsets would need fixing, so hardcoded for now :(
  //   moreOffset = (dataLens[i-1] ? dataLens[i-1] : 0) + trackFragments[i].length;//mdat hadder 8
  //   trackFragments[i] = traf(tracks[i], moreOffset);
  // }
  if (tracks.length == 2) {
    trackFragments[0] = traf(tracks[0], trackFragments[1].length);
    trackFragments[1] = traf(tracks[1], dataLens[0] + trackFragments[0].length);
  }

  return box.apply(null, [types.moof, mfhd(sequenceNumber)].concat(trackFragments));
};
/**
 * Returns a movie box.
 * @param tracks {array} the tracks associated with this movie
 * @see ISO/IEC 14496-12:2012(E), section 8.2.1
 */
moov = function (tracks) {
  var
    i = tracks.length,
    boxes = [];

  while (i--) {
    tracks[i] ? boxes[i] = trak(tracks[i]) : null;
  }

  return box.apply(null, [types.moov, mvhd(0x00000000)/*, iods()*/].concat(boxes).concat(mvex(tracks)));
};
mvex = function (tracks, fps) {
  var
    i = tracks.length,
    boxes = [];

  while (i--) {
    tracks[i] ? boxes[i] = trex(tracks[i], (1000 / tracks[0].fps)) : null;
  }
  return box.apply(null, [types.mvex].concat(boxes));
};

udta = function () {
  return box(types.udta, meta());
};

meta = function () {
  var
    bytes = new Uint8Array([
      0x00, 0x00, // version 0
      0x00, 0x00, // flags
    ]);
  return box(types.meta, bytes, hdlr(), ilst());
};

styp = function () {
  var
    bytes = new Uint8Array([
      0x6D, 0x73, 0x64, 0x68,
      0x00, 0x00, 0x00, 0x00,
      0x6D, 0x73, 0x64, 0x68,
      0x6D, 0x73, 0x69, 0x78
    ]);
  return box(types.styp, bytes);
};

sidx = function (size, ept) {
  var
    bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01,
      //0x00, 0x00, 0x27, 0x10, //25000
      0x00, 0x00, 0x27, 0x10, // timescale, 10000 "ticks" per second
      //0x00, 0x00, 0x03, 0xE8, // timescale, 1000 "ticks" per second
      //0x00, 0x01, 0x5F, 0x90, // timescale, 90,000 "ticks" per second
      (ept & 0xFF000000) >> 24,
      (ept & 0xFF0000) >> 16,
      (ept & 0xFF00) >> 8,
      ept & 0xFF, // Earliest presentation time
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x01,
      (size & 0xFF000000) >> 24,
      (size & 0xFF0000) >> 16,
      (size & 0xFF00) >> 8,
      size & 0xFF, // size
      //0x00, 0x00, 0x27, 0x10, //20000
      //0x00, 0x01, 0x5F, 0x90, // timescale, 90,000 "ticks" per second
      //0x00, 0x00, 0x03, 0xE8, // timescale, 1000 "ticks" per second
      0x00, 0x00, 0x27, 0x10, // timescale, 10000 "ticks" per second
      0x90, 0x00, 0x00, 0x00
    ]);
  return box(types.sidx, bytes);
};

free = function () {
  var
    bytes = new Uint8Array([
      0x49, 0x73, 0x6F, 0x4D,
      0x65, 0x64, 0x69, 0x61,
      0x20, 0x46, 0x69, 0x6C,
      0x65, 0x20, 0x50, 0x72,
      0x6F, 0x64, 0x75, 0x63,
      0x65, 0x64, 0x20, 0x77,
      0x69, 0x74, 0x68, 0x20,
      0x47, 0x50, 0x41, 0x43,
      0x20, 0x30, 0x2E, 0x36,
      0x2E, 0x32, 0x2D, 0x44,
      0x45, 0x56, 0x2D, 0x72,
      0x65, 0x76, 0x36, 0x32,
      0x37, 0x2D, 0x67, 0x38,
      0x61, 0x39, 0x66, 0x39,
      0x38, 0x33, 0x2D, 0x6D,
      0x61, 0x73, 0x74, 0x65,
      0x72, 0x00
    ]);
  return box(types.free, bytes);
};

ilst = function () {
  var
    bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x52,
      0xA9, 0x74, 0x6F, 0x6F,
      0x00, 0x00, 0x00, 0x4A,
      0x64, 0x61, 0x74, 0x61,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00,
      0x4D, 0x79, 0x20, 0x4D,
      0x50, 0x34, 0x42, 0x6F,
      0x78, 0x20, 0x47, 0x55,
      0x49, 0x20, 0x30, 0x2E,
      0x36, 0x2E, 0x30, 0x2E,
      0x36, 0x20, 0x3C, 0x68,
      0x74, 0x74, 0x70, 0x3A,
      0x2F, 0x2F, 0x6D, 0x79,
      0x2D, 0x6D, 0x70, 0x34,
      0x62, 0x6F, 0x78, 0x2D,
      0x67, 0x75, 0x69, 0x2E,
      0x7A, 0x79, 0x6D, 0x69,
      0x63, 0x68, 0x6F, 0x73,
      0x74, 0x2E, 0x63, 0x6F,
      0x6D, 0x3E
    ]);
  return box(types.ilst, bytes);
};

mehd = function () {
  var
    bytes = new Uint8Array([
      0x00, 0x00, // version 0
      0x00, 0x00, // flags
      0x00, 0x00,
      0x2C, 0x10 // Fragment duration
    ]);
  return box(types.mehd, bytes);
};

trep = function () {
  var
    bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00
    ]);

  return box(types.trep, bytes);
};



mvhd = function (duration) {
  var
    bytes = new Uint8Array([
      0x00, // version 0
      0x00, 0x00, 0x00, // flags
      0x00, 0x00, 0x00, 0x01, // creation_time
      0x00, 0x00, 0x00, 0x02, // modification_time
      //0x00, 0x01, 0x5F, 0x90, // timescale, 90,000 "ticks" per second
      //0x00, 0x00, 0x03, 0xE8, // timescale, 1,000 "ticks" per second
      0x00, 0x00, 0x27, 0x10, // timescale, 10000 "ticks" per second
      0xFF, 0xFF, 0xFF, 0xFF, // duration
      // (duration & 0xFF000000) >> 24,
      // (duration & 0xFF0000) >> 16,
      // (duration & 0xFF00) >> 8,
      // duration & 0xFF, // duration
      0x00, 0x01, 0x00, 0x00, // 1.0 rate
      0x01, 0x00, // 1.0 volume
      0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x01, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x40, 0x00, 0x00, 0x00, // transformation: unity matrix
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, // pre_defined
      0xFF, 0xFF, 0xFF, 0xFF // next_track_ID
    ]);
  return box(types.mvhd, bytes);
};

iods = function () {
  var
    bytes = new Uint8Array([
      0x00, 0x00, // version 0
      0x00, 0x00, // flags
      0x10, // Tag
      0x07, // Tag Size
      0x00, //URL flag
      0x4F, 0xFF, 0xFF, 0xFF,
      0x15, 0xFF
    ]);
  return box(types.iods, bytes);
};

sdtp = function (track) {
  var
    samples = track.samples || [],
    bytes = new Uint8Array(4 + samples.length),
    flags,
    i;

  // leave the full box header (4 bytes) all zero

  // write the sample table
  for (i = 0; i < samples.length; i++) {
    flags = samples[i].flags;

    bytes[i + 4] = (flags.dependsOn << 4) |
      (flags.isDependedOn << 2) |
      (flags.hasRedundancy);
  }

  return box(types.sdtp,
    bytes);
};

stbl = function (track) {
  return box(types.stbl,
    stsd(track),
    box(types.stts, STTS),
    box(types.stsc, STSC),
    box(types.stsz, STSZ),
    box(types.stco, STCO));
};

(function () {
  var videoSample, audioSample, opusSample;

  stsd = function (track) {

    return box(types.stsd, new Uint8Array([
      0x00, // version 0
      0x00, 0x00, 0x00, // flags
      0x00, 0x00, 0x00, 0x01
    ]), track.type === 'video' ? videoSample(track) : track.codecType === 'OPUS' ? opusSample(track) : audioSample(track));
  };

  videoSample = function (track) {
    var
      vps = track.vps || [],
      sps = track.sps || [],
      pps = track.pps || [],
      videoParameterSets = [],
      sequenceParameterSets = [],
      pictureParameterSets = [],
      i;

    // assemble the VPSs
    for (i = 0; i < vps.length; i++) {
      videoParameterSets.push((vps[i].byteLength & 0xFF00) >>> 8);
      videoParameterSets.push((vps[i].byteLength & 0xFF)); // videoParameterSetLength
      videoParameterSets = videoParameterSets.concat(Array.prototype.slice.call(vps[i])); // VPS
    }

    // assemble the SPSs
    for (i = 0; i < sps.length; i++) {
      sequenceParameterSets.push((sps[i].byteLength & 0xFF00) >>> 8);
      sequenceParameterSets.push((sps[i].byteLength & 0xFF)); // sequenceParameterSetLength
      sequenceParameterSets = sequenceParameterSets.concat(Array.prototype.slice.call(sps[i])); // SPS
    }

    // assemble the PPSs
    for (i = 0; i < pps.length; i++) {
      pictureParameterSets.push((pps[i].byteLength & 0xFF00) >>> 8);
      pictureParameterSets.push((pps[i].byteLength & 0xFF));
      pictureParameterSets = pictureParameterSets.concat(Array.prototype.slice.call(pps[i]));
    }

    if (track.codecType === "H264") {
      return box(types.avc1, new Uint8Array([
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // data_reference_index
        0x00, 0x00, // pre_defined
        0x00, 0x00, // reserved
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, // pre_defined
        (track.width & 0xff00) >> 8,
        track.width & 0xff, // width
        (track.height & 0xff00) >> 8,
        track.height & 0xff, // height
        0x00, 0x48, 0x00, 0x00, // horizresolution
        0x00, 0x48, 0x00, 0x00, // vertresolution
        0x00, 0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // frame_count
        0x13,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // compressorname
        0x00, 0x18, // depth = 24
        0x11, 0x11 // pre_defined = -1
      ]), box(types.avcC, new Uint8Array([
        0x01, // configurationVersion
        track.profileIdc, // AVCProfileIndication
        track.profileCompatibility, // profile_compatibility
        track.levelIdc, // AVCLevelIndication
        0xff // lengthSizeMinusOne, hard-coded to 4 bytes
      ].concat([
        sps.length // numOfSequenceParameterSets
      ]).concat(sequenceParameterSets).concat([
        pps.length // numOfPictureParameterSets
      ]).concat(pictureParameterSets))));
    } else if (track.codecType === "H265") {
      return box(types.hvc1, new Uint8Array([
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // data_reference_index
        0x00, 0x00, // pre_defined
        0x00, 0x00, // reserved
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, // pre_defined
        (track.width & 0xff00) >> 8,
        track.width & 0xff, // width
        (track.height & 0xff00) >> 8,
        track.height & 0xff, // height
        0x00, 0x48, 0x00, 0x00, // horizresolution
        0x00, 0x48, 0x00, 0x00, // vertresolution
        0x00, 0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // frame_count
        0x13,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // compressorname
        0x00, 0x18, // depth = 24
        0x11, 0x11 // pre_defined = -1
      ]), box(types.hvcC, new Uint8Array([
        0x01,
      ].concat(track.profileTierLevel).concat([
        0xF0, 0x00, 0xFC, 0xFD,
        0xF8, 0xF8, 0x00, 0x00,
        0x0F,
      ]).concat([
        vps.length + sps.length + pps.length
      ]).concat([
        0xA0, 0x00, vps.length // numOfVideoParameterSets
      ]).concat(videoParameterSets).concat([
        0xA1, 0x00, sps.length // numOfSequenceParameterSets
      ]).concat(sequenceParameterSets).concat([
        0xA2, 0x00, pps.length // numOfPictureParameterSets
      ]).concat(pictureParameterSets))));
    } else if (track.codecType === "MJPEG") {
      return box(types.mpv4, new Uint8Array([
        0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // data_reference_index
        0x00, 0x00, // pre_defined
        0x00, 0x00, // reserved
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, // pre_defined
        (track.width & 0xff00) >> 8,
        track.width & 0xff, // width
        (track.height & 0xff00) >> 8,
        track.height & 0xff, // height
        0x00, 0x48, 0x00, 0x00, // horizresolution
        0x00, 0x48, 0x00, 0x00, // vertresolution
        0x00, 0x00, 0x00, 0x00, // reserved
        0x00, 0x01, // frame_count
        0x13,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, // compressorname
        0x00, 0x18, // depth = 24
        0x11, 0x11 // pre_defined = -1
      ]), esds(track));
    } else if (track.codecType === "VP9") {
      return box(types.vp09, visualSampleEntry(track.width, track.height), vpcC(track));
    } else if (track.codecType === "AV1") {
      return box(types.av01, visualSampleEntry(track.width, track.height), av1C(track));
    }
  };

  audioSample = function (track) {
    return box(types.mp4a, new Uint8Array([

      // SampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, // reserved
      0x00, 0x01, // data_reference_index

      // AudioSampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      (track.channelcount & 0xff00) >> 8,
      (track.channelcount & 0xff), // channelcount

      (track.samplesize & 0xff00) >> 8,
      (track.samplesize & 0xff), // samplesize
      0x00, 0x00, // pre_defined
      0x00, 0x00, // reserved

      (track.samplerate & 0xff00) >> 8,
      (track.samplerate & 0xff),
      0x00, 0x00 // samplerate, 16.16

      // MP4AudioSampleEntry, ISO/IEC 14496-14
    ]), esds(track));
  };

  // Same AudioSampleEntry layout as audioSample() above, but closed with a
  // dOps box instead of esds — Opus doesn't have an ES_Descriptor/
  // AudioSpecificConfig. Unlike audioSample() (where this field is always
  // zero because AAC's real sample rate only ever comes from esds's
  // AudioSpecificConfig), this samplerate field has to actually be
  // 48000<<16 here: Chromium's MP4 demuxer cross-checks it against dOps's
  // InputSampleRate and rejects the whole append on a mismatch
  // ("Opus AudioSampleEntry sample rate mismatches OpusSpecificBox..." —
  // confirmed live against a real camera stream) if it's left at 0.
  opusSample = function (track) {
    return box(types.Opus, new Uint8Array([

      // SampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, // reserved
      0x00, 0x01, // data_reference_index

      // AudioSampleEntry, ISO/IEC 14496-12
      0x00, 0x00, 0x00, 0x00, // reserved
      0x00, 0x00, 0x00, 0x00, // reserved
      (track.channelcount & 0xff00) >> 8,
      (track.channelcount & 0xff), // channelcount

      (track.samplesize & 0xff00) >> 8,
      (track.samplesize & 0xff), // samplesize
      0x00, 0x00, // pre_defined
      0x00, 0x00, // reserved

      // samplerate, 16.16 fixed-point — must match dOps's InputSampleRate
      // (also hardcoded to 48000, RFC 7587's fixed Opus-over-RTP clock).
      (48000 >>> 8) & 0xff,
      48000 & 0xff,
      0x00, 0x00
    ]), dOps(track));
  };
}());

tkhd = function (track) {
  var result = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x01, // flags
    0x00, 0x00, 0x00, 0x00, // creation_time
    0x00, 0x00, 0x00, 0x00, // modification_time
    (track.id & 0xFF000000) >> 24,
    (track.id & 0xFF0000) >> 16,
    (track.id & 0xFF00) >> 8,
    track.id & 0xFF, // track_ID
    0x00, 0x00, 0x00, 0x00, // reserved
    0xFF, 0xFF, 0xFF, 0xFF, // duration
    // (track.duration & 0xFF000000) >> 24,
    // (track.duration & 0xFF0000) >> 16,
    // (track.duration & 0xFF00) >> 8,
    // track.duration & 0xFF, // duration
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, // reserved
    0x00, 0x00, // layer
    0x00, 0x00, // alternate_group
    0x01, 0x00, // non-audio track volume
    0x00, 0x00, // reserved
    0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x40, 0x00, 0x00, 0x00, // transformation: unity matrix
    (track.width & 0xFF00) >> 8,
    track.width & 0xFF,
    0x00, 0x00, // width
    (track.height & 0xFF00) >> 8,
    track.height & 0xFF,
    0x00, 0x00 // height
  ]);

  return box(types.tkhd, result);
};

/**
 * Generate a track fragment (traf) box. A traf box collects metadata
 * about tracks in a movie fragment (moof) box.
 */
traf = function (track, moreOffset) {
  var trackFragmentHeader, trackFragmentDecodeTime,
    trackFragmentRun, sampleDependencyTable, dataOffset;

    trackFragmentHeader = box(types.tfhd, new Uint8Array([
      0x00, // version 0
      0x02, 0x00, 0x00,
      // 0x00, 0x00, 0x3a,
      (track.id & 0xFF000000) >> 24,
      (track.id & 0xFF0000) >> 16,
      (track.id & 0xFF00) >> 8,
      (track.id & 0xFF), // track_ID
      // 0x00, 0x00, 0x00, 0x01, // sample_description_index
      // (track.defaultSampleDuration & 0xFF000000) >> 24,
      // (track.defaultSampleDuration & 0xFF0000) >> 16,
      // (track.defaultSampleDuration & 0xFF00) >> 8,
      // (track.defaultSampleDuration & 0xFF), // default_sample_duration
      // // 0x00, 0x00, 0x00, 0x00, // default_sample_duration
      // 0x00, 0x00, 0x00, 0x00, // default_sample_size
      // 0x00, 0x00, 0x00, 0x00  // default_sample_flags
    ]));

  trackFragmentDecodeTime = box(types.tfdt, new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    // baseMediaDecodeTime
    (track.baseMediaDecodeTime >>> 24) & 0xFF,
    (track.baseMediaDecodeTime >>> 16) & 0xFF,
    (track.baseMediaDecodeTime >>> 8) & 0xFF,
    track.baseMediaDecodeTime & 0xFF
  ]));

  // the data offset specifies the number of bytes from the start of
  // the containing moof to the first payload byte of the associated
  // mdat
  dataOffset = (16 + //32 + // tfhd
  // dataOffset = (16 + //32 + // tfhd
  // dataOffset = (32 + // tfhd
    16 + // tfdt
    8 +  // traf header
    16 + // mfhd
    8 +  // moof header
    8 +
    moreOffset);  // mdat header

  trackFragmentRun = trun(track,
                          /*sampleDependencyTable.length + */dataOffset);
  return box(types.traf,
    trackFragmentHeader,
    trackFragmentDecodeTime,
    trackFragmentRun
             /*sampleDependencyTable*/);
};

/**
 * Generate a track box.
 * @param track {object} a track definition
 * @return {Uint8Array} the track box
 */
trak = function (track) {
  track.duration = track.duration || 0x00000000;
  return box(types.trak,
    tkhd(track),
    mdia(track));
};

trex = function (track, sampleDuration) {
  var result = new Uint8Array([
    0x00, // version 0
    0x00, 0x00, 0x00, // flags
    (track.id & 0xFF000000) >> 24,
    (track.id & 0xFF0000) >> 16,
    (track.id & 0xFF00) >> 8,
    (track.id & 0xFF), // track_ID
    0x00, 0x00, 0x00, 0x01, // default_sample_description_index
    (sampleDuration & 0xFF000000) >> 24,
    (sampleDuration & 0xFF0000) >> 16,
    (sampleDuration & 0xFF00) >> 8,
    (sampleDuration & 0xFF), // track_ID
    0x00, 0x00, 0x00, 0x00, // default_sample_size
    0x00, 0x01, 0x00, 0x00 // default_sample_flags
  ]);
  // the last two bytes of default_sample_flags is the sample
  // degradation priority, a hint about the importance of this sample
  // relative to others. Lower the degradation priority for all sample
  // types other than video.
  if (track.type !== 'video') {
    result[result.length - 1] = 0x00;
  }

  return box(types.trex, result);
};

(function () {
  var audioTrun, videoTrun, trunHeader, trunHeader1, trunHeader1Cts;

  // This method assumes all samples are uniform. That is, if a
  // duration is present for the first sample, it will be present for
  // all subsequent samples.
  // see ISO/IEC 14496-12:2012, Section 8.8.8.1
  //trunHeader for not exiting frame ducation value
  trunHeader = function (samples, offset) {
    var durationPresent = 0, sizePresent = 0,
        flagsPresent = 0, compositionTimeOffset = 0;

    // trun flag constants
    if (samples.length) {
      if (samples[0].duration !== undefined) {
        durationPresent = 0x1;
      }
      if (samples[0].size !== undefined) {
        sizePresent = 0x2;
      }
      if (samples[0].flags !== undefined) {
        flagsPresent = 0x4;
      }
      if (samples[0].compositionTimeOffset !== undefined) {
        compositionTimeOffset = 0x8;
      }
    }    

    return [
      0x00, // version 0
      0x00,
      durationPresent | sizePresent | flagsPresent | compositionTimeOffset,
      0x01, // flags
      (samples.length & 0xFF000000) >>> 24,
      (samples.length & 0xFF0000) >>> 16,
      (samples.length & 0xFF00) >>> 8,
      samples.length & 0xFF, // sample_count
      (offset & 0xFF000000) >>> 24,
      (offset & 0xFF0000) >>> 16,
      (offset & 0xFF00) >>> 8,
      offset & 0xFF // data_offset
    ];
  };
  //trunHeader for existing frame duration value
  trunHeader1 = function (samples, offset) {
    return [
      0x00, 0x00, // version 0
      0x03, 0x05, // flags
      (samples.length & 0xFF000000) >>> 24,
      (samples.length & 0xFF0000) >>> 16,
      (samples.length & 0xFF00) >>> 8,
      samples.length & 0xFF, // sample_count
      (offset & 0xFF000000) >>> 24,
      (offset & 0xFF0000) >>> 16,
      (offset & 0xFF00) >>> 8,
      offset & 0xFF, // data_offset
      0x00, 0x00, 0x00, 0x00
    ];
  };

  // Same as trunHeader1, plus the sample-composition-time-offset flag (0x800) and version 1
  // (signed offsets — a B-frame source's CTS can be negative for the first few samples of a
  // GOP). Used only when every sample in this trun carries a `compositionTimeOffset` — see
  // VideoTagPlayer.ts's getVideoCompositionTimeOffset().
  trunHeader1Cts = function (samples, offset) {
    return [
      0x01, 0x00, // version 1
      0x0B, 0x05, // flags: data-offset | first-sample-flags | duration | size | composition-time-offset
      (samples.length & 0xFF000000) >>> 24,
      (samples.length & 0xFF0000) >>> 16,
      (samples.length & 0xFF00) >>> 8,
      samples.length & 0xFF, // sample_count
      (offset & 0xFF000000) >>> 24,
      (offset & 0xFF0000) >>> 16,
      (offset & 0xFF00) >>> 8,
      offset & 0xFF, // data_offset
      0x00, 0x00, 0x00, 0x00
    ];
  };

  videoTrun = function (track, offset) {
    var bytes, samples, sample, i, cts;
    samples = track.samples || [];
    if (samples[0].frameDuration == null) {
      offset += 8 + 12 + 4 + (4 * samples.length); // size
      bytes = trunHeader(samples, offset);
      for (i = 0; i < samples.length; i++) {
        sample = samples[i];
        bytes = bytes.concat([
          (sample.size & 0xFF000000) >>> 24,
          (sample.size & 0xFF0000) >>> 16,
          (sample.size & 0xFF00) >>> 8,
          sample.size & 0xFF, // sample_size

        ]);
      }
    } else if (samples[0].compositionTimeOffset !== undefined) {
      offset += 8 + 12 + 4 + (4 * samples.length) + (4 * samples.length) + (4 * samples.length); // duration, size, cts
      bytes = trunHeader1Cts(samples, offset);
      for (i = 0; i < samples.length; i++) {
        sample = samples[i];
        cts = sample.compositionTimeOffset | 0; // coerce to a signed 32-bit integer
        bytes = bytes.concat([
          (sample.frameDuration & 0xFF000000) >>> 24,
          (sample.frameDuration & 0xFF0000) >>> 16,
          (sample.frameDuration & 0xFF00) >>> 8,
          sample.frameDuration & 0xFF, // sample_duration
          (sample.size & 0xFF000000) >>> 24,
          (sample.size & 0xFF0000) >>> 16,
          (sample.size & 0xFF00) >>> 8,
          sample.size & 0xFF, // sample_size
          (cts & 0xFF000000) >>> 24,
          (cts & 0xFF0000) >>> 16,
          (cts & 0xFF00) >>> 8,
          cts & 0xFF // sample_composition_time_offset
        ]);
      }
    } else {
      offset += 8 + 12 + 4 + (4 * samples.length) + (4 * samples.length); //duration and size
      bytes = trunHeader1(samples, offset);
      for (i = 0; i < samples.length; i++) {
        sample = samples[i];
        bytes = bytes.concat([
          (sample.frameDuration & 0xFF000000) >>> 24,
          (sample.frameDuration & 0xFF0000) >>> 16,
          (sample.frameDuration & 0xFF00) >>> 8,
          sample.frameDuration & 0xFF, // sample_duration
          (sample.size & 0xFF000000) >>> 24,
          (sample.size & 0xFF0000) >>> 16,
          (sample.size & 0xFF00) >>> 8,
          sample.size & 0xFF, // sample_size

        ]);
      }

    }
    return box(types.trun, new Uint8Array(bytes));
  };

  audioTrun = function (track, offset) {
    var bytes, samples, sample, i;

    samples = track.samples || [];
    offset += 8 + 12 + ((samples[0].duration ? 8 : 4) * samples.length);

    bytes = trunHeader(samples, offset);

    for (i = 0; i < samples.length; i++) {
      sample = samples[i];
      if(sample.duration) {
        bytes = bytes.concat([
          (sample.duration & 0xFF000000) >>> 24,
          (sample.duration & 0xFF0000) >>> 16,
          (sample.duration & 0xFF00) >>> 8,
          sample.duration & 0xFF, // sample_duration
          (sample.size & 0xFF000000) >>> 24,
          (sample.size & 0xFF0000) >>> 16,
          (sample.size & 0xFF00) >>> 8,
          sample.size & 0xFF]); // sample_size
      } else {
        bytes = bytes.concat([
          (sample.size & 0xFF000000) >>> 24,
          (sample.size & 0xFF0000) >>> 16,
          (sample.size & 0xFF00) >>> 8,
          sample.size & 0xFF]); // sample_size
      }

    }

    return box(types.trun, new Uint8Array(bytes));
  };

  trun = function (track, offset) {
    if (track.type === 'audio') {
      return audioTrun(track, offset);
    }

    return videoTrun(track, offset);
  };
}());

function initSegment(tracks) {
  var fileType = ftyp();
  var movie = moov(tracks);
  var result;

  result = new Uint8Array(fileType.byteLength + movie.byteLength);
  result.set(fileType);
  result.set(movie, fileType.byteLength);

  // arr = [];
  // arr.push(result);

  // var blob = new Blob(arr, { type: "application/octet-binary"});
  // var link = document.createElement("a");
  // link.href = window.URL.createObjectURL(blob);
  // link.download = "test.mp4";
  // link.click();
  return result;
}

function mediaSegment(sequenceNumber, tracks, data, ept) {
  var moofBox = moof(sequenceNumber, tracks);
  var frameData = mdat(data);
  var result;

  result = new Uint8Array(moofBox.byteLength + frameData.byteLength);
  result.set(moofBox);
  result.set(frameData, moofBox.byteLength);

  // arr.push(result);
  // if((arr.length > 100)) {//% 100) === 0) {
  //   var blob = new Blob(arr, { type: "application/octet-binary"});
  //   var link = document.createElement("a");
  //   link.href = window.URL.createObjectURL(blob);
  //   link.download = "test.mp4";
  //   link.click();
  //   arr = [];
  // }
  return result;
}

function dualTrackMediaSegment(sequenceNumber, tracks, data, ept) {
  var mediaData = [], mdatlen = 0; mdatLens = [], i = 0;//data.length;
  // build traf boxes for each track fragment
  while (i < data.length) {
    mdatLens[i] = data[i].length;
    mdatlen += data[i].length;
    i++;
  }
  mediaData = new Uint8Array(mdatlen);
  i = 0;
  var offset = 0;
  while (i < data.length) {
    mediaData.set(data[i], offset);
    offset += mdatLens[i];
    i++;
  }

  var moofBox = moof(sequenceNumber, tracks, mdatLens);
  var frameData = mdat(mediaData);
  var result;

  result = new Uint8Array(moofBox.byteLength + frameData.byteLength);
  result.set(moofBox);
  result.set(frameData, moofBox.byteLength);

  // arr.push(result);
  // if((arr.length > 200)) {//% 100) === 0) {
  //   var blob = new Blob(arr, { type: "application/octet-binary"});
  //   var link = document.createElement("a");
  //   link.href = window.URL.createObjectURL(blob);
  //   link.download = "test.mp4";
  //   link.click();
  //   arr = [];
  // }
  return result;
}

export { initSegment, mediaSegment, dualTrackMediaSegment };
