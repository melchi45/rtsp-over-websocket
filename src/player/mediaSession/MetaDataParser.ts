import { XMLParser } from 'fast-xml-parser';
import { fromHex } from '../util/hex';
import { fastJsonStringfy } from '../util/fastJsonStringfy';
import { RTSPOverWebSocketError } from '../exceptions/RTSPOverWebSocketError';
import { createDebugLogger, type DebugConfig, type DebugLogger, NOOP_DEBUG_LOGGER } from '../util/debugLog';

export interface ParsedMetaData {
  channelId: number;
  xml?: string;
  json?: string;
}

// Options mirror the legacy player's own fast-xml-parser v2-era call
// (attributeNamePrefix/attrNodeName/textNodeName/ignoreAttributes/
// ignoreNameSpace/allowBooleanAttributes/parseNodeValue/parseAttributeValue/
// decodeHTMLchar), translated to fast-xml-parser v5's option names --
// `attrNodeName` -> `attributesGroupName`, `ignoreNameSpace` ->
// `removeNSPrefix` (inverted sense preserved: `false` on both keeps
// namespace prefixes like `tt:` on tag names, which ONVIF metadata XML
// needs), `parseNodeValue` -> `parseTagValue`, `decodeHTMLchar` ->
// `htmlEntities`.
const xmlParser = new XMLParser({
  attributeNamePrefix: '',
  attributesGroupName: '@attributes',
  textNodeName: 'value',
  ignoreAttributes: false,
  removeNSPrefix: false,
  allowBooleanAttributes: true,
  parseTagValue: true,
  parseAttributeValue: false,
  htmlEntities: true
});

/**
 * Ported from the legacy player's Util/metaDataParser.
 *
 * Real bug, found live: legacy's own `window.parser` (an optional
 * `external-lib/fast-xml-parser` CDN script the legacy demo page loaded)
 * used to be read defensively here rather than bundled, matching legacy's
 * own graceful-degradation contract (`.xml`/the callback still fire without
 * it, only `.json` enrichment was skipped). Confirmed live: neither of this
 * repo's own consumers (`src/index.html`'s demo, `wisenet-camera-discovery`)
 * ever actually loaded that optional script, so `.json` was *always*
 * `undefined` in practice for every real consumer -- not a rare degraded
 * path, the only path. Now bundles `fast-xml-parser` as a real dependency
 * (Vite statically includes it in the built output, same as `moment`/`vis`/
 * `file-saver` already are -- no runtime CDN fetch, so this is safe for a
 * Manifest V3 Chrome extension's CSP, unlike loading a CDN script would be)
 * so `.json` is always populated whenever `.xml` is.
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

  /** See util/debugLog.ts. */
  private debugLog: DebugLogger = NOOP_DEBUG_LOGGER;
  set debug(config: DebugConfig | null) {
    this.debugLog = createDebugLogger(config, 'mediaSession', 'MetaDataParser');
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

      const json = xmlParser.parse(metaData.xml);
      metaData.json = fastJsonStringfy(json);

      this.debugLog.debug('parse() ->', metaData.json);
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
