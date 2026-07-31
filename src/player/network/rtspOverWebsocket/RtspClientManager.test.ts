import { describe, it, expect } from 'vitest';
import { loadLegacyModule, type LegacySandbox } from '../../test-support/loadLegacyModule';
import { createNetworkLegacySandbox, decimalToHex } from '../../test-support/legacyGlobals';
import { RtspClientManager } from './RtspClientManager';

interface LegacyRtspClientManagerInstance {
  CreateRtspClient(): unknown;
  DeleteRtspClient(rtspClient: unknown): void;
  GetRtspClientCount(): number;
}

interface LegacyRtspClientManager {
  getInstance(): LegacyRtspClientManagerInstance;
}

/**
 * rtspClientManager.js is a module-level singleton (its own IIFE closure).
 * `RtspClientManager` (the port) is likewise a true module singleton shared
 * by every test in this file (same as it would be in a real page load), so
 * — like the legacy side, loaded fresh here into its own vm context — this
 * suite exercises both as one continuous scenario rather than resetting
 * state between assertions.
 */
function newLegacyManager(): LegacyRtspClientManager {
  const base = createNetworkLegacySandbox();
  const sandbox: LegacySandbox = {
    ...base,
    decimalToHex,
    DigestGenerator: loadLegacyModule('Util/digestGenerator.js', 'DigestGenerator', {
      CryptoJS: base.CryptoJS,
      decimalToHex,
      log: base.log
    })
  };
  sandbox.RtspClient = loadLegacyModule('Network/RTSPoverWebsocket/rtspClient.js', 'RtspClient', sandbox);
  return loadLegacyModule('Network/RTSPoverWebsocket/rtspClientManager.js', 'RtspClientManager', sandbox);
}

describe('RtspClientManager parity with the legacy player’s Network/RTSPoverWebsocket/rtspClientManager.js', () => {
  it('getInstance/CreateRtspClient/DeleteRtspClient/GetRtspClientCount all behave identically across a full scenario', () => {
    const legacy = newLegacyManager();
    const legacyInstance = legacy.getInstance();
    expect(legacy.getInstance()).toBe(legacyInstance);

    const ported = RtspClientManager;
    const portedInstance = ported.getInstance();
    expect(ported.getInstance()).toBe(portedInstance);

    expect(portedInstance.getRtspClientCount()).toBe(legacyInstance.GetRtspClientCount());

    // CreateRtspClient preserves a genuine legacy bug: it pushes the new
    // instance internally but returns the constructor itself, not the
    // created instance — both sides return a function, not an object.
    const legacyCreated = legacyInstance.CreateRtspClient();
    const portedCreated = portedInstance.createRtspClient();
    expect(typeof portedCreated).toBe(typeof legacyCreated);
    expect(portedInstance.getRtspClientCount()).toBe(legacyInstance.GetRtspClientCount());

    legacyInstance.CreateRtspClient();
    portedInstance.createRtspClient();
    expect(portedInstance.getRtspClientCount()).toBe(legacyInstance.GetRtspClientCount());

    // Deleting an object that was never created by this manager is a no-op.
    legacyInstance.DeleteRtspClient({});
    portedInstance.deleteRtspClient({} as never);
    expect(portedInstance.getRtspClientCount()).toBe(legacyInstance.GetRtspClientCount());
  });
});
