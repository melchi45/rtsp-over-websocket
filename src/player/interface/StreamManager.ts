import { StreamPlayer, type StreamPlayerInfo, type StreamPlayerControlData } from './StreamPlayer';
import type { MediaRouterFactories } from '../mediaSession/MediaRouter';
import type { SunapiClientLike, TransportFactory } from '../network/rtspOverWebsocket/RtspClient';

interface StreamLookupInfo {
  media: { element?: unknown };
  device: { channelId?: number | null };
}

function generateChannelInfo(channelId: number | null | undefined, elementId: unknown): StreamLookupInfo {
  return {
    media: { element: elementId },
    device: { channelId: channelId || 0 }
  };
}

function computeId(info: StreamLookupInfo): unknown {
  return info.media.element ? info.media.element : info.device.channelId === null ? 0 : info.device.channelId;
}

/**
 * Ported from the legacy player’s Interface/streamManager.js.
 *
 * Legacy builds `StreamManager` as `var StreamManager = (function () { ...
 * function Constructor() {}; Constructor.prototype = {...}; return
 * Constructor; })();` — the `playerContainer`/`currentPlayer` state lives in
 * the IIFE's closure, OUTSIDE `Constructor`, so it is shared across every
 * `new StreamManager()` instance (a quasi-singleton via `new`). Reproduced
 * here with module-level state for the same reason. `checkPlayer` is
 * confirmed write-only in legacy (set in `initStreamPlayer`, never read
 * anywhere) and is dropped.
 */
const playerContainer: StreamPlayer[] = [];
let currentPlayer: StreamPlayer | null = null;

export class StreamManager {
  /**
   * @param info Structure with device/media/callback info (same shape StreamPlayer.control expects).
   * @param sunapiClient sunapiClient object, forwarded to a newly-created StreamPlayer.
   * @param mediaRouterFactories Optional DI seam for the StreamPlayer this may construct — not part of the legacy signature, defaults to real browser-backed factories.
   * @param transportFactory Optional DI seam for the StreamPlayer's RtspClient transport — not part of the legacy signature.
   */
  initStreamPlayer(
    info: StreamPlayerInfo,
    sunapiClient: SunapiClientLike | null,
    mediaRouterFactories?: MediaRouterFactories,
    transportFactory?: TransportFactory
  ): void {
    let player = this.lookup(info);
    if (!player) {
      if (info.media.requestInfo.cmd === 'close') {
        return;
      }
      player =
        typeof mediaRouterFactories === 'undefined'
          ? new StreamPlayer(info, sunapiClient)
          : new StreamPlayer(info, sunapiClient, mediaRouterFactories, transportFactory);
      player.playerId = info.media.element ? info.media.element : info.device.channelId === null ? 0 : info.device.channelId;
      playerContainer.push(player);
    } else {
      const controlData: StreamPlayerControlData = {
        channelId: info.device.channelId,
        elementId: info.media.element,
        cmd: 'reassignCanvas',
        data: null
      };
      player.controlWorker(controlData);
    }
  }

  lookup(info: StreamLookupInfo): StreamPlayer | undefined {
    const id = computeId(info);
    let found: StreamPlayer | undefined;
    if (playerContainer.length > 0) {
      playerContainer.some((player) => {
        // eslint-disable-next-line eqeqeq
        if (player && player.playerId == id) {
          found = player;
          return true;
        }
        return false;
      });
    }
    return found;
  }

  remove(info: StreamLookupInfo): void {
    const id = computeId(info);
    if (playerContainer.length > 0) {
      let i = 0;
      playerContainer.forEach((player) => {
        // eslint-disable-next-line eqeqeq
        if (player.playerId == id) {
          playerContainer.splice(i, 1);
        }
        i++;
      });
    }
  }

  controlPlayer(info: StreamPlayerInfo): void {
    const player = this.lookup(info);
    if (player) {
      currentPlayer = player;
      player.control(info);
    }
  }

  controlWorker(controlData: StreamPlayerControlData): void {
    const player = this.lookup(generateChannelInfo(controlData.channelId, controlData.elementId));
    if (player) {
      currentPlayer = player;
      player.controlWorker(controlData);
    }
  }

  destroyPlayer(channelId: number | null | undefined, elementId: unknown): void {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      player.controlWorker({ channelId: channelId ?? undefined, elementId, cmd: 'initVideo', data: [false] });
      player.controlWorker({ channelId: channelId ?? undefined, elementId, cmd: 'setLiveMode', data: ['canvas'] });
      player.controlWorker({ channelId: channelId ?? undefined, elementId, cmd: 'controlAudioListen', data: ['volumn', 0] });
      player.controlWorker({ channelId: channelId ?? undefined, elementId, cmd: 'controlAudioTalk', data: ['volumn', 0] });
    }
    this.remove(generateChannelInfo(channelId, elementId));
  }

  getCurrentState(channelId: number | null | undefined, elementId: unknown): string | undefined {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      return player.getCurrentState();
    }
    return undefined;
  }

  getVideoPlayer(): unknown {
    return currentPlayer!.getVideoPlayer();
  }

  getVideoWidth(channelId: number | null | undefined, elementId: unknown): number | null | undefined {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      return player.getVideoWidth();
    }
    return undefined;
  }

  getVideoHeight(channelId: number | null | undefined, elementId: unknown): number | null | undefined {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      return player.getVideoHeight();
    }
    return undefined;
  }

  getVideoCodecType(channelId: number | null | undefined, elementId: unknown): string | null | undefined {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      return player.getVideoCodecType();
    }
    return undefined;
  }

  getAudioVolume(channelId: number | null | undefined, elementId: unknown): number | undefined {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      return player.getAudioVolume();
    }
    return undefined;
  }

  setAudioVolume(channelId: number | null | undefined, elementId: unknown, volume: number): void {
    const player = this.lookup(generateChannelInfo(channelId, elementId));
    if (player) {
      currentPlayer = player;
      player.setAudioVolume(volume);
    }
  }

  getPlayerLength(): number {
    return playerContainer.length;
  }
}
