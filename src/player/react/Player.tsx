import React, { useState, useEffect, useRef } from 'react';
import { RTSPOverWebSocket } from '../elements/RTSPOverWebSocket';
import { RTSPOverWebSocketPlayState } from '../elements/RTSPOverWebSocketTypes';
import { RTSPOverWebSocketError } from '../exceptions';
import type { PlayerProps } from './Constant';

// `<rtsp-over-websocket>` is registered as a real custom element by the
// `RTSPOverWebSocket` import above (a `customElements.define(...)` side
// effect — see RTSPOverWebSocket.ts) but TypeScript/JSX has no built-in
// knowledge of it; this teaches JSX its element/attribute shape so
// `<rtsp-over-websocket {...props} />` below type-checks.
interface RTSPOverWebSocketElementAttributes extends React.HTMLAttributes<RTSPOverWebSocket> {
  hostname?: string;
  port?: string;
  username?: string;
  password?: string;
  profile?: string;
  channel?: string;
  device?: string;
  autoplay?: string;
  statistics?: string;
  https?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'rtsp-over-websocket': React.DetailedHTMLProps<RTSPOverWebSocketElementAttributes, RTSPOverWebSocket>;
    }
  }
}

/**
 * Adapted from react-wisenet-player's `components/ump-player/Player.tsx`,
 * targeting this library's own `<rtsp-over-websocket>` element instead of
 * `<ump-player>`. Event names below are this element's real ones (see
 * RTSPOverWebSocket.ts's `dispatch(...)` call sites) — not a blind
 * find-replace of the `ump-player` names, which don't all carry over
 * (`close`/`networkstate`/`stream` have no equivalent here;
 * `changeclient`/`changemute`/`changepassword`/`changeprotocol`/`rtsp`/
 * `sunapiclient` exist here but weren't in the ump-player original).
 *
 * The original's login-flow imports (SunapiManager/AccountService/
 * AttributeService/LoginDialog/NavigationBar/Controller) were dead code
 * there already (the whole call chain was commented out, and the JSX never
 * rendered LoginDialog/NavigationBar/Controller), so they aren't ported.
 * Same for the `window.CryptoJS`/`window.Matrix` global assignments —
 * this library's own code imports `crypto-js`/`three` as real ES modules
 * instead of expecting those browser globals.
 */
export const Player: React.FC<PlayerProps> = (props: PlayerProps) => {
  const [playerClassName] = useState('rtsp-over-websocket-player');
  const playerRef = useRef<RTSPOverWebSocket | null>(null);
  const [playState, setPlayState] = useState<RTSPOverWebSocketPlayState>(RTSPOverWebSocketPlayState.STOPPED);

  const onError = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    console.log('onError: ' + JSON.stringify(detail));
  };

  const onMeta = (event: Event): void => {
    console.log('onMeta: ' + event);
  };

  const onResize = (event: Event): void => {
    console.log('onResize: ' + event);
    if (playerRef.current) {
      playerRef.current.video.style.width = '100%';
      playerRef.current.video.style.height = '100%';
    }
  };

  const onStateChanged = (event: Event): void => {
    const detail = (event as CustomEvent).detail;
    console.log('onStateChanged: ' + JSON.stringify(detail));
    setPlayState(detail.readyState);

    switch (detail.readyState) {
      case RTSPOverWebSocketPlayState.PLAYING:
        console.log('Playing');
        break;
      case RTSPOverWebSocketPlayState.STOPPED:
        console.log('Stopped');
        break;
      default:
        break;
    }
  };

  const onTimestamp = (_event: Event): void => {
    // console.log('onTimestamp: ' + event.detail.timestamp);
  };

  const onCapture = (event: Event): void => {
    console.log('onCapture: ' + event);
  };

  const onStatistics = (event: Event): void => {
    console.log('onStatistics: ' + JSON.stringify((event as CustomEvent).detail));
  };

  const onBackupState = (event: Event): void => {
    console.log('onBackupState: ' + JSON.stringify((event as CustomEvent).detail));
  };

  const onPlayerModeChanged = (event: Event): void => {
    console.log('onPlayerModeChanged: ' + event);
  };

  const onInstantPlayback = (event: Event): void => {
    console.log('onInstantPlayback: ' + event);
  };

  const onWaiting = (event: Event): void => {
    console.log('onWaiting: ' + event);
  };

  const onMetaImage = (event: Event): void => {
    console.log('onMetaImage: ' + event);
  };

  const onUsernameChanged = (event: Event): void => {
    console.log('onUsernameChanged: ' + event);
  };

  const onDeviceTypeChanged = (event: Event): void => {
    console.log('onDeviceTypeChanged: ' + event);
  };

  const onProfileNumberChanged = (event: Event): void => {
    console.log('onProfileNumberChanged: ' + event);
  };

  const onProfileNameChanged = (event: Event): void => {
    console.log('onProfileNameChanged: ' + event);
  };

  const onChannelNumberChanged = (event: Event): void => {
    console.log('onChannelNumberChanged: ' + JSON.stringify((event as CustomEvent).detail));
    const player = event.target as RTSPOverWebSocket;
    if (player) {
      if (player.isplay) {
        player.stop();
      }
      player.play();
    }
  };

  const onHostnameChanged = (event: Event): void => {
    console.log('onHostnameChanged: ' + event);
    const player = event.target as RTSPOverWebSocket;
    if (player) {
      if (player.isplay) {
        player.stop();
      }
      player.play();
    }
  };

  const onVolumeLevelChanged = (event: Event): void => {
    console.log('onVolumeLevelChanged: ' + event);
  };

  const onPortNumberChanged = (event: Event): void => {
    console.log('onPortNumberChanged: ' + event);
  };

  const onFullscreenModeChanged = (event: Event): void => {
    console.log('onFullscreenModeChanged: ' + event);
  };

  const onSunapiClientChanged = (event: Event): void => {
    console.log('onSunapiClientChanged: ' + event);
  };

  const onBestshotFilterChanged = (event: Event): void => {
    console.log('onBestshotFilterChanged: ' + event);
  };

  const onBestshot = (event: Event): void => {
    console.log('onBestshot: ' + event);
  };

  const onTimezoneChanged = (event: Event): void => {
    console.log('onTimezoneChanged: ' + event);
  };

  const onUnload = (event: BeforeUnloadEvent): void => {
    if (playerRef.current && playerRef.current.isplay) {
      playerRef.current.stop();
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    event.returnValue = '';
  };

  useEffect(() => {
    console.log('Player Component mounted!');
    window.addEventListener('beforeunload', onUnload);

    playerRef.current = document.getElementById(props.device.id) as RTSPOverWebSocket | null;
    if (playerRef.current === null) {
      throw new RTSPOverWebSocketError({
        place: 'Player.tsx:useEffect',
        elementId: props.device.id,
        message: `Player with ID attribute ${props.device.id} not found`
      });
    }

    const player = playerRef.current;
    player.addEventListener('error', onError);
    player.addEventListener('meta', onMeta);
    player.addEventListener('resize', onResize);
    player.addEventListener('statechange', onStateChanged);
    player.addEventListener('timestamp', onTimestamp);
    player.addEventListener('capture', onCapture);
    player.addEventListener('statistics', onStatistics);
    player.addEventListener('backupstatechange', onBackupState);
    player.addEventListener('changeplayermode', onPlayerModeChanged);
    player.addEventListener('instantplayback', onInstantPlayback);
    player.addEventListener('waiting', onWaiting);
    player.addEventListener('metaImage', onMetaImage);

    player.addEventListener('changeusername', onUsernameChanged);
    player.addEventListener('changedevicetype', onDeviceTypeChanged);
    player.addEventListener('changeprofilenumber', onProfileNumberChanged);
    player.addEventListener('changeprofile', onProfileNameChanged);
    player.addEventListener('changechannel', onChannelNumberChanged);
    player.addEventListener('changehostname', onHostnameChanged);
    player.addEventListener('changevolume', onVolumeLevelChanged);
    player.addEventListener('changeport', onPortNumberChanged);
    player.addEventListener('changefullscreen', onFullscreenModeChanged);
    player.addEventListener('changesunapiclient', onSunapiClientChanged);
    player.addEventListener('changebestshotfilter', onBestshotFilterChanged);
    player.addEventListener('changebestshot', onBestshot);
    player.addEventListener('changetimezone', onTimezoneChanged);

    return () => {
      console.log('Player Component unmounted!');
      if (playerRef.current === null) {
        throw new RTSPOverWebSocketError({
          place: 'Player.tsx:useEffect',
          elementId: props.device.id,
          message: `Player with ID attribute ${props.device.id} not found`
        });
      }

      if (playerRef.current.isplay) {
        playerRef.current.stop();
      }

      window.removeEventListener('beforeunload', onUnload);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div id={'container-' + props.device.id} className="container">
      <rtsp-over-websocket
        id={props.device.id}
        className={`${playerClassName} ${playState !== RTSPOverWebSocketPlayState.STOPPED ? 'active' : ''}`}
        hostname={props.device.hostname}
        port={String(props.device.port)}
        username={props.device.username}
        password={props.device.password}
        profile={props.device.profile}
        channel={String(props.device.channel)}
        device={props.device.device}
        autoplay={props.device.autoplay ? '' : undefined}
        statistics={props.device.statistics ? '' : undefined}
        https={props.device.https ? '' : undefined}
      />
    </div>
  );
};

export default Player;
