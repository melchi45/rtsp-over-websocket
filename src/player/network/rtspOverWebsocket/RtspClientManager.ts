import { RtspClient } from './RtspClient';

/**
 * Ported from the legacy player’s Network/RTSPoverWebsocket/rtspClientManager.js.
 *
 * NOTE: confirmed unused — no file anywhere in the legacy player references
 * `RtspClientManager`/`RtspClientMgr`; the custom element constructs
 * `RtspClient` instances directly instead. Ported anyway for completeness.
 *
 * NOTE: `createRtspClient()` has a genuine legacy bug, preserved here as-is:
 * it pushes the newly created instance onto the internal list, but returns
 * the `RtspClient` constructor itself rather than the created instance.
 * Since nothing in the codebase calls this manager, the bug has never had
 * an observed effect.
 */
class RtspClientManagerImpl {
  private readonly rtspClientList: RtspClient[] = [];

  createRtspClient(): typeof RtspClient {
    const newRtspClient = new RtspClient();
    this.rtspClientList.push(newRtspClient);
    return RtspClient;
  }

  deleteRtspClient(rtspClient: RtspClient): void {
    const idx = this.rtspClientList.indexOf(rtspClient);
    if (idx !== -1) {
      this.rtspClientList.splice(idx, 1);
    }
  }

  getRtspClientCount(): number {
    return this.rtspClientList.length;
  }
}

let rtspManagerInstance: RtspClientManagerImpl | undefined;

export const RtspClientManager = {
  getInstance(): RtspClientManagerImpl {
    if (!rtspManagerInstance) {
      rtspManagerInstance = new RtspClientManagerImpl();
    }
    return rtspManagerInstance;
  }
};
