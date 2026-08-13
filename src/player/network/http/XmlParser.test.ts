// @vitest-environment jsdom
// `DOMParser` is a browser global (jsdom provides it) — this project's default
// vitest environment is `node`, which doesn't have it. See
// SunapiManager.live.test.ts's own doc comment for the same override pattern.
import { describe, expect, it } from 'vitest';
import { XmlParser } from './XmlParser';

const ATTRIBUTE_XML = `<attributes>
  <group name="System">
    <category name="Support">
      <attribute name="PTZSupport" type="bool" value="True"/>
      <attribute name="MaxChannel" type="int" value="4"/>
      <attribute name="ExcludeSettings" type="csv" value="Network,Security"/>
    </category>
    <category name="Limit">
      <channel number="0">
        <attribute name="IRLED" type="bool" value="True"/>
      </channel>
      <channel number="1">
        <attribute name="IRLED" type="bool" value="False"/>
      </channel>
    </category>
  </group>
</attributes>`;

const CGI_XML = `<cgis>
  <cgi name="system.cgi">
    <submenu name="deviceinfo">
      <parameter name="DeviceName" request="true">
        <dataType><string minlen="0" maxlen="15"/></dataType>
      </parameter>
      <parameter name="Language">
        <dataType><enum><entry value="English"/><entry value="Korean"/></enum></dataType>
      </parameter>
      <parameter name="MaxUser">
        <dataType><int min="1" max="16"/></dataType>
      </parameter>
      <parameter name="Enable">
        <dataType><bool/></dataType>
      </parameter>
    </submenu>
  </cgi>
</cgis>`;

describe('XmlParser.parseAttributeSection', () => {
  it('parses a bool attribute', () => {
    const parser = new XmlParser();
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/PTZSupport')).toBe(true);
  });

  it('parses an int attribute', () => {
    const parser = new XmlParser();
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/MaxChannel')).toBe(4);
  });

  it('parses a csv attribute into an array', () => {
    const parser = new XmlParser();
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/ExcludeSettings')).toEqual(['Network', 'Security']);
  });

  it('returns undefined for an attribute that does not exist', () => {
    const parser = new XmlParser();
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/NoSuchAttribute')).toBeUndefined();
  });

  it('caches the parsed document across calls with the same XML string', () => {
    const parser = new XmlParser();
    // Two calls against the identical string should both succeed and return
    // consistent results, exercising the cache-hit path (skip re-parse).
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/PTZSupport')).toBe(true);
    expect(parser.parseAttributeSection(ATTRIBUTE_XML, 'System/Support/MaxChannel')).toBe(4);
  });
});

describe('XmlParser.parseAttributeSectionByChannel', () => {
  it('parses a per-channel attribute indexed by channel number', () => {
    const parser = new XmlParser();
    const result = parser.parseAttributeSectionByChannel(ATTRIBUTE_XML, 'System/Limit/IRLED', 2);
    expect(result).toEqual([true, false]);
  });

  it('falls back to channel 0 when there are no <channel> nodes', () => {
    const parser = new XmlParser();
    const result = parser.parseAttributeSectionByChannel(ATTRIBUTE_XML, 'System/Support/PTZSupport', 1);
    expect(result[0]).toBe(true);
  });

  it('returns a sparse array sized to maxChannel when the group/category is missing', () => {
    const parser = new XmlParser();
    const result = parser.parseAttributeSectionByChannel(ATTRIBUTE_XML, 'NoSuchGroup/NoSuchCategory/Attr', 3);
    expect(result.length).toBe(3);
    expect(result.every((value) => value === undefined)).toBe(true);
  });
});

describe('XmlParser.parseCgiSection', () => {
  it('parses a string-type parameter into min/max length metadata', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/DeviceName/string')).toEqual({
      minLength: '0',
      maxLength: '15'
    });
  });

  it('parses an int-type parameter into min/max value metadata', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/MaxUser/int')).toEqual({
      minValue: 1,
      maxValue: 16
    });
  });

  it('parses an enum-type parameter into an array of entry values', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/Language/enum')).toEqual(['English', 'Korean']);
  });

  it('parses a bool-type parameter as a boolean', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/Enable/bool')).toBe(true);
  });

  it('resolves the 3-token submenu/parameter/datatype form the same as the 4-token form', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'deviceinfo/MaxUser/int')).toEqual({
      minValue: 1,
      maxValue: 16
    });
  });

  it('sets isRequest when parseRequest is passed and the parameter has a request attribute', () => {
    const parser = new XmlParser();
    const result = parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/DeviceName/string', { parseRequest: true });
    expect(result).toMatchObject({ isRequest: true });
  });

  it('returns undefined for a parameter that does not exist', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'system.cgi/deviceinfo/NoSuchParam/string')).toBeUndefined();
  });

  it('returns undefined for an input string with an unsupported token count', () => {
    const parser = new XmlParser();
    expect(parser.parseCgiSection(CGI_XML, 'only/one/two/three/four/five')).toBeUndefined();
  });
});
