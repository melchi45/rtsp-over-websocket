import { RtpSession } from '../RtpSession';
import { G711AudioEncoder } from '../../talk/encoder/G711AudioEncoder';

function intToByteArrayHtoN(valueIn: number, len: number, bytearray: Uint8Array, lastpos: number): void {
  let value = valueIn;
  for (let index = lastpos; index > lastpos - len; index -= 1) {
    const byteval = value & 0xff;
    bytearray[index] = byteval;
    value = (value - byteval) / 256;
  }
}

export class AudioTalkSession extends RtpSession {
  private readonly rtpHeaderSize = 12;
  private readonly rtspHeaderSize = 4;
  private sequenceNum = 0xffde;
  private readonly ssrcId = Math.floor(Math.random() * 1000000 + 1);
  private readonly audioEncoder = new G711AudioEncoder();
  private readonly channelID: number;

  constructor(channel: number) {
    super();
    this.channelID = channel;
  }

  setSampleRate(sampleRate: number): void {
    this.audioEncoder.setSampleRate(sampleRate);
  }

  override getRTPPacket(buffer: Float32Array): Uint8Array {
    const rtpPayload = this.audioEncoder.encode(buffer);
    const payloadSize = this.rtpHeaderSize + rtpPayload.length;

    const rtspheader = new Uint8Array(4);
    rtspheader[0] = 0x24;
    rtspheader[1] = this.channelID;
    intToByteArrayHtoN(payloadSize, 2, rtspheader, 3);

    const rtpheader = new Uint8Array(12);
    rtpheader[0] = 0x80;
    rtpheader[1] = 0x80;
    this.sequenceNum += 1;
    intToByteArrayHtoN(this.sequenceNum, 2, rtpheader, 3);
    intToByteArrayHtoN(Date.now(), 4, rtpheader, 7);
    intToByteArrayHtoN(this.ssrcId, 4, rtpheader, 11);

    const rtpPacket = new Uint8Array(this.rtpHeaderSize + rtpPayload.length + 4);
    rtpPacket.set(rtspheader, 0);
    rtpPacket.set(rtpheader, this.rtspHeaderSize);
    rtpPacket.set(rtpPayload, this.rtspHeaderSize + this.rtpHeaderSize);

    return rtpPacket;
  }
}
