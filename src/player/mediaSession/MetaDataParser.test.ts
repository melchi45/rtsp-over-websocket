import { describe, expect, it, vi } from 'vitest';
import { MetaDataParser, type ParsedMetaData } from './MetaDataParser';

const ONVIF_SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<tt:MetadataStream
    xmlns:tt="http://www.onvif.org/ver10/schema"
    xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2">
    <tt:VideoAnalytics>
        <tt:Frame UtcTime="2026-09-04T01:53:30.158Z" VideoSourceToken="VideoSourceToken-0">
            <tt:Transformation>
                <tt:Translate x="-1.0" y="1.0"/>
                <tt:Scale x="0.000977" y="-0.001302"/>
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

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('MetaDataParser', () => {
  it('populates both xml and json from a real ONVIF metadata frame', () => {
    const received: ParsedMetaData[] = [];
    const parser = new MetaDataParser((metaData) => received.push(metaData));
    parser.channelId = 1;

    parser.parse(toBytes(ONVIF_SAMPLE_XML));

    expect(received).toHaveLength(1);
    expect(received[0].channelId).toBe(1);
    expect(received[0].xml).toContain('<tt:MetadataStream');
    expect(typeof received[0].json).toBe('string');

    const json = JSON.parse(received[0].json as string);
    const frame = json['tt:MetadataStream']['tt:VideoAnalytics']['tt:Frame'];
    // Namespace prefixes preserved (removeNSPrefix: false).
    expect(frame['@attributes'].UtcTime).toBe('2026-09-04T01:53:30.158Z');
    expect(frame['@attributes'].VideoSourceToken).toBe('VideoSourceToken-0');

    const shape = frame['tt:Object']['tt:Appearance']['tt:Shape'];
    // Attribute values kept as strings (parseAttributeValue: false), not
    // coerced to numbers -- matches the original numeric-looking "0.0"
    // staying a string, same as the legacy fast-xml-parser call intended.
    expect(shape['tt:BoundingBox']['@attributes'].left).toBe('0.0');
    expect(shape['tt:BoundingBox']['@attributes'].right).toBe('1511.0');

    const classCandidate = frame['tt:Object']['tt:Appearance']['tt:Class']['tt:ClassCandidate'];
    expect(classCandidate['tt:Type']).toBe('Other');
    // Tag text values ARE parsed (parseTagValue: true) -- a bare numeric
    // text node becomes a real number.
    expect(classCandidate['tt:Likelihood']).toBe(0.55);
  });

  it('does not call back for non-XML input', () => {
    const callback = vi.fn();
    const parser = new MetaDataParser(callback);

    parser.parse(toBytes('not xml at all'));

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not call back for empty input', () => {
    const callback = vi.fn();
    const parser = new MetaDataParser(callback);

    parser.parse(new Uint8Array(0));

    expect(callback).not.toHaveBeenCalled();
  });
});
