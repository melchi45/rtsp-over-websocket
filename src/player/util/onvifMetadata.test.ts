import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { parseOnvifVideoAnalyticsFrame } from './onvifMetadata';

// Same fast-xml-parser configuration MetaDataParser.ts uses in production --
// kept in sync deliberately (not imported from there) so this test exercises
// the exact JSON shape onvifMetadata.ts must handle, independent of that
// module's own internals.
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

function toJson(xml: string): string {
  return JSON.stringify(xmlParser.parse(xml));
}

const ONE_OBJECT_WITH_TRANSFORMATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream
    xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
    <tt:VideoAnalytics>
        <tt:Frame UtcTime="2026-09-04T01:53:30.158Z" VideoSourceToken="VideoSourceToken-0">
            <tt:Transformation>
                <tt:Translate x="0" y="0"/>
                <tt:Scale x="1" y="1"/>
            </tt:Transformation>
            <tt:Object ObjectId="0">
                <tt:Appearance>
                    <tt:Shape>
                        <tt:BoundingBox left="0.0" top="0.0" right="1511.0" bottom="1535.0"/>
                        <tt:CenterOfGravity x="755.5" y="767.5"/>
                    </tt:Shape>
                    <tt:Class>
                        <tt:ClassCandidate>
                            <tt:Type>Other</tt:Type>
                            <tt:Likelihood>0.55</tt:Likelihood>
                        </tt:ClassCandidate>
                    </tt:Class>
                </tt:Appearance>
            </tt:Object>
        </tt:Frame>
    </tt:VideoAnalytics>
</tt:MetadataStream>`;

// Verbatim capture from a real live Wisenet/Samsung camera (2048x1536 MJPEG
// profile), reported live as producing no visible bounding box -- see
// MEMORY.md. Locks in both the Transformation fix (parseBoundingBox) and the
// pre-existing, deliberate non-handling of the vendor's non-standard bare
// `<tt:Type Likelihood="...">` sibling under `tt:Class` as a regression
// guard for this exact real-world payload.
const REAL_DEVICE_CAPTURE_XML = `<?xml version="1.0"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ttr="https://www.onvif.org/ver20/analytics/radiometry"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tns1="http://www.onvif.org/ver10/topics"
    xmlns:tnssamsung="http://www.samsungcctv.com/2011/event/topics" xmlns:fc="http://www.onvif.org/ver20/analytics/humanface"
    xmlns:bd="http://www.onvif.org/ver20/analytics/humanbody">
    <tt:VideoAnalytics>
        <tt:Frame UtcTime="2026-09-04T04:06:07.109Z" VideoSourceToken="VideoSourceToken-0">
            <tt:Transformation>
                <tt:Translate x="-1.0" y="1.0"/>
                <tt:Scale x="0.000977" y="-0.001302"/>
            </tt:Transformation>
            <tt:Object ObjectId="0">
                <tt:Appearance>
                    <tt:Shape>
                        <tt:BoundingBox left="0.0" top="0.0" right="1455.0" bottom="1535.0"/>
                        <tt:CenterOfGravity x="727.5" y="767.5"/>
                    </tt:Shape>
                    <tt:Class>
                        <tt:ClassCandidate>
                            <tt:Type>Other</tt:Type>
                            <tt:Likelihood>0.55</tt:Likelihood>
                        </tt:ClassCandidate>
                        <tt:Type Likelihood="0.55">Fire</tt:Type>
                    </tt:Class>
                </tt:Appearance>
            </tt:Object>
        </tt:Frame>
    </tt:VideoAnalytics>
</tt:MetadataStream>`;

const NO_TRANSFORMATION_MULTI_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream xmlns:tt="http://www.onvif.org/ver10/schema">
    <tt:VideoAnalytics>
        <tt:Frame UtcTime="2026-09-04T02:00:00.000Z">
            <tt:Object ObjectId="1">
                <tt:Appearance>
                    <tt:Shape>
                        <tt:BoundingBox left="10.0" top="20.0" right="30.0" bottom="40.0"/>
                    </tt:Shape>
                    <tt:Class>
                        <tt:ClassCandidate>
                            <tt:Type>Human</tt:Type>
                            <tt:Likelihood>0.91</tt:Likelihood>
                        </tt:ClassCandidate>
                        <tt:ClassCandidate>
                            <tt:Type>Other</tt:Type>
                            <tt:Likelihood>0.09</tt:Likelihood>
                        </tt:ClassCandidate>
                    </tt:Class>
                </tt:Appearance>
            </tt:Object>
            <tt:Object ObjectId="2">
                <tt:Appearance>
                    <tt:Class>
                        <tt:ClassCandidate>
                            <tt:Type>Vehicle</tt:Type>
                            <tt:Likelihood>0.77</tt:Likelihood>
                        </tt:ClassCandidate>
                    </tt:Class>
                </tt:Appearance>
            </tt:Object>
        </tt:Frame>
    </tt:VideoAnalytics>
</tt:MetadataStream>`;

describe('parseOnvifVideoAnalyticsFrame', () => {
  it('parses a real single-object ONVIF sample with an identity Transformation', () => {
    const frame = parseOnvifVideoAnalyticsFrame(toJson(ONE_OBJECT_WITH_TRANSFORMATION_XML));

    expect(frame).not.toBeNull();
    expect(frame?.utcTime).toBe('2026-09-04T01:53:30.158Z');
    expect(frame?.videoSourceToken).toBe('VideoSourceToken-0');
    expect(frame?.objects).toHaveLength(1);

    const object = frame!.objects[0];
    expect(object.objectId).toBe('0');
    // Shape coordinates are read directly, unaffected by Transformation.
    expect(object.boundingBox).toEqual({ left: 0, top: 0, right: 1511, bottom: 1535 });
    expect(object.centerOfGravity).toEqual({ x: 755.5, y: 767.5 });
    expect(object.classCandidates).toEqual([{ type: 'Other', likelihood: 0.55 }]);
  });

  it('ignores a non-identity Transformation -- BoundingBox/CenterOfGravity pass through as-is', () => {
    // Exact Translate/Scale values captured from a real Wisenet/Samsung
    // camera (2048x1536) -- see onvifMetadata.ts's parseBoundingBox doc
    // comment and MEMORY.md: this Transformation is a pixel-to-normalized
    // ONVIF-compliance recipe (scaleX/scaleY ~= 2/width, ~= -2/height), not
    // something to apply to already-pixel Shape data. An earlier version of
    // this parser *did* apply it (inverse-divided), which blew these exact
    // numbers up into coordinates far outside the video frame and silently
    // broke the overlay on real hardware despite every synthetic test (this
    // one included, before this fix) passing.
    const xml = ONE_OBJECT_WITH_TRANSFORMATION_XML.replace(
      '<tt:Translate x="0" y="0"/>\n                <tt:Scale x="1" y="1"/>',
      '<tt:Translate x="-1.0" y="1.0"/>\n                <tt:Scale x="0.000977" y="-0.001302"/>'
    );
    const frame = parseOnvifVideoAnalyticsFrame(toJson(xml));

    expect(frame!.objects[0].boundingBox).toEqual({ left: 0, top: 0, right: 1511, bottom: 1535 });
    expect(frame!.objects[0].centerOfGravity).toEqual({ x: 755.5, y: 767.5 });
  });

  it('normalizes multiple tt:Object / tt:ClassCandidate entries into arrays', () => {
    const frame = parseOnvifVideoAnalyticsFrame(toJson(NO_TRANSFORMATION_MULTI_OBJECT_XML));

    expect(frame?.objects).toHaveLength(2);
    expect(frame?.objects[0].objectId).toBe('1');
    expect(frame?.objects[0].classCandidates).toEqual([
      { type: 'Human', likelihood: 0.91 },
      { type: 'Other', likelihood: 0.09 }
    ]);
    // No Transformation in this sample -- coordinates pass through as-is.
    expect(frame?.objects[0].boundingBox).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });

    // Second object has no Shape at all -- boundingBox/centerOfGravity stay
    // undefined, classCandidates still populate.
    expect(frame?.objects[1].objectId).toBe('2');
    expect(frame?.objects[1].boundingBox).toBeUndefined();
    expect(frame?.objects[1].centerOfGravity).toBeUndefined();
    expect(frame?.objects[1].classCandidates).toEqual([{ type: 'Vehicle', likelihood: 0.77 }]);
  });

  it('parses the real device capture (2048x1536 Wisenet/Samsung camera) with a pixel-space BoundingBox that must survive its Transformation unchanged', () => {
    const frame = parseOnvifVideoAnalyticsFrame(toJson(REAL_DEVICE_CAPTURE_XML));

    expect(frame).not.toBeNull();
    expect(frame?.objects).toHaveLength(1);
    const object = frame!.objects[0];
    // Within the live 2048x1536 frame -- not the ~1,490,286 / ~-1,178,187
    // garbage the pre-fix inverse-Transformation formula produced for these
    // exact numbers (which also made the SVG <rect> height negative, so
    // browsers silently refused to render it at all).
    expect(object.boundingBox).toEqual({ left: 0, top: 0, right: 1455, bottom: 1535 });
    expect(object.centerOfGravity).toEqual({ x: 727.5, y: 767.5 });
    // Only the standard ClassCandidate is read; the vendor's bare
    // `<tt:Type Likelihood="0.55">Fire</tt:Type>` sibling is deliberately
    // not special-cased (see parseClassCandidates's doc comment).
    expect(object.classCandidates).toEqual([{ type: 'Other', likelihood: 0.55 }]);
  });

  it('returns null for JSON that is not a VideoAnalytics Frame', () => {
    expect(parseOnvifVideoAnalyticsFrame(JSON.stringify({ 'tt:MetadataStream': {} }))).toBeNull();
    expect(parseOnvifVideoAnalyticsFrame(JSON.stringify({ notOnvifAtAll: true }))).toBeNull();
  });

  it('returns null (does not throw) for malformed JSON', () => {
    expect(parseOnvifVideoAnalyticsFrame('{not valid json')).toBeNull();
  });
});
