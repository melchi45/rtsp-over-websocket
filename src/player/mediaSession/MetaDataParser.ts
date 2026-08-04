import { fromHex } from '../util/hex';
import { fastJsonStringfy } from '../util/fastJsonStringfy';
import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';

export interface ParsedMetaData {
  channelId: number;
  xml?: string;
  json?: string;
}

interface FastXmlParserLike {
  validate(xml: string): boolean;
  parse(xml: string, options: Record<string, unknown>): unknown;
}

/**
 * Ported from the legacy player’s Util/metaDataParser.js.
 *
 * `window.parser` (the optional `external-lib/fast-xml-parser` CDN script
 * the legacy demo page loaded) is read defensively here rather than
 * bundled as a new dependency: legacy itself treats it as fully optional
 * (`typeof window.parser !== 'undefined'` gates only the `.json` enrichment
 * — `.xml`/the callback still fire without it), so this matches that
 * graceful-degradation contract exactly rather than forcing the feature on.
 */
export class MetaDataParser {
  private channelIdValue = 0;
  private deviceTypeValue: string | undefined;

  constructor(private readonly callback: (metaData: ParsedMetaData) => void) {}

  get channelId(): number {
    return this.channelIdValue;
  }

  set channelId(v: number) {
    this.channelIdValue = v;
  }

  get deviceType(): string | undefined {
    return this.deviceTypeValue;
  }

  set deviceType(v: string | undefined) {
    this.deviceTypeValue = v;
  }

  // NOTE: legacy memoizes converted characters by codepoint (`charCache`) to
  // avoid repeated String.fromCodePoint calls — a pure perf optimization
  // with no effect on the output string, dropped here for simplicity.
  private utf8ArrayToStr(array: Uint8Array): string {
    const charFromCodePt = String.fromCodePoint || String.fromCharCode;
    const result: string[] = [];
    const buffLen = array.length;
    let codePt: number;
    let byte1: number;

    for (let i = 0; i < buffLen; ) {
      byte1 = array[i++];

      if (byte1 <= 0x7f) {
        codePt = byte1;
      } else if (byte1 <= 0xdf) {
        codePt = ((byte1 & 0x1f) << 6) | (array[i++] & 0x3f);
      } else if (byte1 <= 0xef) {
        codePt = ((byte1 & 0x0f) << 12) | ((array[i++] & 0x3f) << 6) | (array[i++] & 0x3f);
        // Cast: TS's lib types treat String.fromCodePoint as always defined,
        // but legacy feature-detects it for older-browser fallback — kept
        // as a real (if now unreachable in practice) branch for fidelity.
      } else if ((String as unknown as { fromCodePoint?: unknown }).fromCodePoint) {
        codePt = ((byte1 & 0x07) << 18) | ((array[i++] & 0x3f) << 12) | ((array[i++] & 0x3f) << 6) | (array[i++] & 0x3f);
      } else {
        codePt = 63; // Cannot convert four byte code points, so use "?" instead
        i += 3;
      }

      result.push(charFromCodePt(codePt));
    }
    return result.join('');
  }

  parse(byteData: Uint8Array): void {
    const metaData: ParsedMetaData = { channelId: this.channelId };

    try {
      if (typeof TextDecoder === 'function') {
        // reference: https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder
        metaData.xml = new TextDecoder().decode(byteData);
      } else {
        metaData.xml = this.utf8ArrayToStr(byteData);
      }

      if (!metaData.xml || metaData.xml.indexOf('<?xml') < 0) {
        return;
      }

      const parser = (globalThis as unknown as { window?: { parser?: FastXmlParserLike } }).window?.parser;
      if (typeof parser !== 'undefined') {
        if (!parser.validate(metaData.xml)) {
          throw new Error('This xml is not valid xml format fast using xml parser library.');
        }
        const options = {
          attributeNamePrefix: '',
          attrNodeName: '@attributes',
          textNodeName: 'value',
          ignoreAttributes: false,
          ignoreNameSpace: false,
          allowBooleanAttributes: true,
          parseNodeValue: true,
          parseAttributeValue: false,
          decodeHTMLchar: true
        };
        const json = parser.parse(metaData.xml, options);
        metaData.json = fastJsonStringfy(json);
      }

      this.callback(metaData);
    } catch (error) {
      throw new RTSPOverWebSocketError({
        channelId: this.channelId,
        errorCode: fromHex('0x0907'),
        place: 'MetaDataParser.ts:parse',
        message: `Metadata Parsing Error  [${(error as Error).message}]`
      });
    }
  }
}
