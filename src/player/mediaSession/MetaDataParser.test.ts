import { describe, it, expect, vi } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../test-support/loadLegacyModule';
import { createMediaSessionLegacySandbox } from '../test-support/legacyGlobals';
import { MetaDataParser, type ParsedMetaData } from './MetaDataParser';

interface LegacyMetaDataParser {
  channelId: number;
  deviceType: string | undefined;
  parse(byteData: Uint8Array): void;
}

function buildSandbox(): LegacySandbox {
  return { ...createMediaSessionLegacySandbox() };
}

function newLegacy(callback: (data: ParsedMetaData) => void): LegacyMetaDataParser {
  const Ctor = loadLegacyModule<new (cb: (data: ParsedMetaData) => void) => LegacyMetaDataParser>('Util/metaDataParser.js', 'MetaDataParser', buildSandbox());
  return new Ctor(callback);
}

function xmlBytes(xml: string): Uint8Array {
  return new TextEncoder().encode(xml);
}

describe('MetaDataParser parity with the legacy player’s Util/metaDataParser.js', () => {
  it('channelId/deviceType round-trip identically (real per-instance accessors)', () => {
    const legacy = newLegacy(() => {});
    const ported = new MetaDataParser(() => {});

    legacy.channelId = 3;
    ported.channelId = 3;
    expect(ported.channelId).toBe(legacy.channelId);

    legacy.deviceType = 'nvr';
    ported.deviceType = 'nvr';
    expect(ported.deviceType).toBe(legacy.deviceType);
  });

  it('parse() decodes valid XML via TextDecoder and invokes the callback with {channelId, xml}, identically', () => {
    const legacyCb = vi.fn();
    const legacy = newLegacy(legacyCb);
    legacy.channelId = 2;
    const portedCb = vi.fn();
    const ported = new MetaDataParser(portedCb);
    ported.channelId = 2;

    const bytes = xmlBytes('<?xml version="1.0"?><root><a>1</a></root>');
    legacy.parse(bytes);
    ported.parse(bytes);

    expect(portedCb).toHaveBeenCalledTimes(1);
    expect(legacyCb).toHaveBeenCalledTimes(1);
    expect(portedCb.mock.calls[0][0]).toEqual(legacyCb.mock.calls[0][0]);
    expect(portedCb.mock.calls[0][0]).toEqual({ channelId: 2, xml: '<?xml version="1.0"?><root><a>1</a></root>' });
  });

  it('parse() silently returns (no callback) when the decoded bytes are not XML, identically', () => {
    const legacyCb = vi.fn();
    const legacy = newLegacy(legacyCb);
    const portedCb = vi.fn();
    const ported = new MetaDataParser(portedCb);

    const bytes = xmlBytes('not xml at all');
    legacy.parse(bytes);
    ported.parse(bytes);

    expect(portedCb).not.toHaveBeenCalled();
    expect(legacyCb).not.toHaveBeenCalled();
  });

  it('parse() silently returns for empty input, identically', () => {
    const legacyCb = vi.fn();
    const legacy = newLegacy(legacyCb);
    const portedCb = vi.fn();
    const ported = new MetaDataParser(portedCb);

    legacy.parse(new Uint8Array());
    ported.parse(new Uint8Array());

    expect(portedCb).not.toHaveBeenCalled();
    expect(legacyCb).not.toHaveBeenCalled();
  });

  it('parse() enriches metaData.json only when window.parser is available, identically (both skip it here)', () => {
    const legacyCb = vi.fn();
    const legacy = newLegacy(legacyCb);
    const portedCb = vi.fn();
    const ported = new MetaDataParser(portedCb);

    const bytes = xmlBytes('<?xml version="1.0"?><a/>');
    legacy.parse(bytes);
    ported.parse(bytes);

    expect(legacyCb.mock.calls[0][0].json).toBeUndefined();
    expect(portedCb.mock.calls[0][0].json).toBeUndefined();
  });
});
