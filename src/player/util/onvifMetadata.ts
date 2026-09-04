/**
 * Extracts a small typed model from the JSON `MetaDataParser` already
 * produces (see `mediaSession/MetaDataParser.ts`) for a real ONVIF
 * `tt:MetadataStream`/`tt:VideoAnalytics` frame -- see
 * `docs/player/10-onvif-metadata-overlay.md` for the full reference and
 * `docs/DESIGN.md` §2.7 for the coordinate-mapping algorithm this
 * implements. Pure functions only: no DOM, no network, nothing beyond
 * `JSON.parse` and arithmetic, so this is unit-testable in a plain Node
 * environment (see `onvifMetadata.test.ts`).
 *
 * `MetaDataParser`'s `fast-xml-parser` options (`removeNSPrefix: false`,
 * `attributesGroupName: '@attributes'`, `textNodeName: 'value'`,
 * `parseTagValue: true`, `parseAttributeValue: false`) shape every object
 * key/value read here -- namespace prefixes (`tt:`) stay on keys, an
 * element's attributes live under a nested `'@attributes'` key, tag text
 * values are parsed to their natural JS type but attribute values are
 * always left as strings.
 */

export interface OnvifBoundingBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OnvifPoint {
  x: number;
  y: number;
}

export interface OnvifClassCandidate {
  type: string;
  likelihood: number;
}

export interface OnvifAnalyticsObject {
  objectId: string;
  /** Read directly from `tt:BoundingBox`'s attributes -- already intrinsic
   *  pixel space on real Wisenet/Samsung hardware; `tt:Transformation` is
   *  deliberately not applied to it (see `parseBoundingBox`'s doc comment). */
  boundingBox?: OnvifBoundingBox;
  centerOfGravity?: OnvifPoint;
  classCandidates: OnvifClassCandidate[];
}

export interface OnvifVideoAnalyticsFrame {
  utcTime: string;
  videoSourceToken?: string;
  objects: OnvifAnalyticsObject[];
}

/** `fast-xml-parser` returns a bare object for a single occurrence of an
 *  element and an array for repeated ones -- this repo's `MetaDataParser`
 *  options don't configure `isArray`, so callers here always normalize
 *  both shapes into an array before iterating. `undefined`/`null` become
 *  an empty array (element absent entirely). */
function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseNumericAttribute(attributes: Record<string, unknown> | undefined, key: string): number | undefined {
  if (attributes === undefined || attributes === null) {
    return undefined;
  }
  const raw = attributes[key];
  if (typeof raw === 'number') {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * `tt:Frame/tt:Transformation` (`Translate`/`Scale`) is deliberately NOT
 * applied to Shape coordinates -- found to be actively wrong via a real
 * device capture (see `MEMORY.md`'s "bounding box still not showing, real
 * device" entry). On the real Wisenet/Samsung camera this was verified
 * against, `tt:BoundingBox`/`tt:CenterOfGravity` are already reported in the
 * video's own intrinsic pixel space (confirmed two ways: their magnitudes
 * matched the live 2048x1536 resolution, and `CenterOfGravity` was exactly
 * the `BoundingBox`'s own midpoint -- both only make sense if both are
 * already the same untransformed pixel coordinates). That device's
 * `Transformation` block (e.g. `Translate x="-1.0" y="1.0"`,
 * `Scale x="0.000977" y="-0.001302"`) is instead a *pixel-to-normalized*
 * ONVIF-compliance recipe -- `scaleX`/`scaleY` come out to `~= 2/width`/
 * `~= -2/height` for that camera's real resolution, i.e. exactly the
 * standard pixel -> [-1, 1] conversion, for a client that wants the
 * strictly-normalized ONVIF coordinate convention instead of this vendor's
 * raw-pixel Shape values. Applying it to already-pixel data (in either
 * direction) corrupts it -- an earlier version of this file *inverse*-applied
 * it (`px = (raw - translate) / scale`), which blew up these exact real
 * values into coordinates far outside the video frame (an SVG `<rect>` with
 * a resulting negative height, which browsers silently refuse to render) --
 * this is why the overlay drew nothing despite every earlier synthetic test
 * passing (those tests asserted against the same wrong formula, not against
 * real device output).
 */
function parseBoundingBox(shape: Record<string, unknown> | undefined): OnvifBoundingBox | undefined {
  const attributes = (shape?.['tt:BoundingBox'] as { '@attributes'?: Record<string, unknown> } | undefined)?.[
    '@attributes'
  ];
  const left = parseNumericAttribute(attributes, 'left');
  const top = parseNumericAttribute(attributes, 'top');
  const right = parseNumericAttribute(attributes, 'right');
  const bottom = parseNumericAttribute(attributes, 'bottom');
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    return undefined;
  }
  return { left, top, right, bottom };
}

function parseCenterOfGravity(shape: Record<string, unknown> | undefined): OnvifPoint | undefined {
  const attributes = (shape?.['tt:CenterOfGravity'] as { '@attributes'?: Record<string, unknown> } | undefined)?.[
    '@attributes'
  ];
  const x = parseNumericAttribute(attributes, 'x');
  const y = parseNumericAttribute(attributes, 'y');
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return { x, y };
}

/** Only the standard ONVIF `ClassCandidate` list (`tt:Type` + `tt:Likelihood`
 *  child elements) is read -- a vendor-only bare `tt:Type Likelihood="...">`
 *  shape confirmed live alongside it on a real device (see `MEMORY.md`'s
 *  `MetaDataParser.parse()` entry) is not standard ONVIF and is
 *  deliberately not special-cased here. */
function parseClassCandidates(appearance: Record<string, unknown> | undefined): OnvifClassCandidate[] {
  const classDescriptor = appearance?.['tt:Class'] as Record<string, unknown> | undefined;
  if (classDescriptor === undefined || classDescriptor === null) {
    return [];
  }
  const candidates = toArray(classDescriptor['tt:ClassCandidate'] as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const result: OnvifClassCandidate[] = [];
  for (const candidate of candidates) {
    const type = candidate['tt:Type'];
    const likelihood = candidate['tt:Likelihood'];
    if (typeof type === 'string' && typeof likelihood === 'number') {
      result.push({ type, likelihood });
    }
  }
  return result;
}

function parseObject(object: Record<string, unknown>): OnvifAnalyticsObject | null {
  const objectId = (object['@attributes'] as Record<string, unknown> | undefined)?.ObjectId;
  if (typeof objectId !== 'string' && typeof objectId !== 'number') {
    return null;
  }
  const appearance = object['tt:Appearance'] as Record<string, unknown> | undefined;
  const shape = appearance?.['tt:Shape'] as Record<string, unknown> | undefined;
  return {
    objectId: String(objectId),
    boundingBox: parseBoundingBox(shape),
    centerOfGravity: parseCenterOfGravity(shape),
    classCandidates: parseClassCandidates(appearance)
  };
}

/**
 * Parses `MetaDataParser`'s already-produced JSON string into a typed
 * `OnvifVideoAnalyticsFrame`. Returns `null` (never throws) for anything
 * that isn't this exact `tt:MetadataStream`/`tt:VideoAnalytics`/`tt:Frame`
 * shape -- malformed JSON, a different ONVIF metadata topic, or a `Frame`
 * with no usable `Object` at all -- so callers can treat every non-`null`
 * result as immediately renderable.
 */
export function parseOnvifVideoAnalyticsFrame(json: string): OnvifVideoAnalyticsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const metadataStream = (parsed as Record<string, unknown>)['tt:MetadataStream'] as Record<string, unknown> | undefined;
  const videoAnalytics = metadataStream?.['tt:VideoAnalytics'] as Record<string, unknown> | undefined;
  const frame = videoAnalytics?.['tt:Frame'] as Record<string, unknown> | undefined;
  if (frame === undefined || frame === null) {
    return null;
  }
  const frameAttributes = frame['@attributes'] as Record<string, unknown> | undefined;
  const utcTime = frameAttributes?.UtcTime;
  if (typeof utcTime !== 'string') {
    return null;
  }
  const videoSourceToken = frameAttributes?.VideoSourceToken;

  const objects: OnvifAnalyticsObject[] = [];
  for (const rawObject of toArray(frame['tt:Object'] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const object = parseObject(rawObject);
    if (object !== null) {
      objects.push(object);
    }
  }

  return {
    utcTime,
    videoSourceToken: typeof videoSourceToken === 'string' ? videoSourceToken : undefined,
    objects
  };
}
