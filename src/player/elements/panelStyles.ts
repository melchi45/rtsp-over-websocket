/**
 * CSS text blocks injected into `document.head` by RTSPOverWebSocket's
 * DOM-builder methods (statistics/network-state/context-menu/gesture-overlay
 * panels). Extracted verbatim from the legacy player's custom-element source's
 * inline `[appendStyle](...)` string literals purely to keep
 * RTSPOverWebSocket.ts's line count manageable — no text was altered, only
 * lifted into named constants.
 */

export const CHANNEL_DIV_STYLE =
  '.channel_div {\r\n' +
  'display: none;\r\n' +
  'background: rgba(28,28,28,0.5);\r\n' +
  'border: 5px;\r\n' +
  'border-radius: 4px;\r\n' +
  'color: #fff;\r\n' +
  'left: 10px;\r\n' +
  'top: 10px;\r\n' +
  'position: absolute;\r\n' +
  'z-index: 1000;\r\n' +
  'float: right;\r\n' +
  'border: 2px solid #003B62;\r\n' +
  '}';

/** Positions the main stats panel and the separate collapsible
 * .statistics-data panel (see STATISTICS_DATA_STYLE) as a single stacked
 * column, so the Data panel's own content length (raw JSON, can be long
 * and vary a lot per event) growing/shrinking only reflows within its own
 * box — not the main panel's, which used to sit right on top of it inside
 * one flex column and would visibly shift/resize the whole panel every
 * time Data's text changed length. */
export const STATISTICS_GROUP_STYLE =
  '.statistics-group{\r\n' +
  'display: flex;\r\n' +
  'flex-direction: column;\r\n' +
  'align-items: flex-end;\r\n' +
  'row-gap: 8px;\r\n' +
  'right: 10px;\r\n' +
  'bottom: 30px;\r\n' +
  'position: absolute;\r\n' +
  'z-index: 1000;\r\n' +
  '}';

export const STATISTICS_STYLE =
  '.statistics {\r\n' +
  'display: flex;\r\n' +
  'flex-direction: column;\r\n' +
  'background: rgba(15,17,21,0.78);\r\n' +
  '-webkit-backdrop-filter: blur(6px);\r\n' +
  'backdrop-filter: blur(6px);\r\n' +
  'border: 1px solid rgba(255,255,255,0.08);\r\n' +
  'border-radius: 10px;\r\n' +
  'box-shadow: 0 4px 16px rgba(0,0,0,0.35);\r\n' +
  'color: #E8EAED;\r\n' +
  'padding: 6px 10px;\r\n' +
  'font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;\r\n' +
  'font-size: 10px;\r\n' +
  'line-height: 1.3;\r\n' +
  'min-width: 18em;\r\n' +
  'max-width: 26em;\r\n' +
  '}';

export const STATISTICS_DIV_STYLE =
  '.statistics div{\r\n' +
  'border: 0px;\r\n' +
  'border-bottom: 1px solid rgba(255,255,255,0.06);\r\n' +
  'margin: 0px;\r\n' +
  'padding: 2px 0px;\r\n' +
  'background: transparent;\r\n' +
  'font-family: inherit;\r\n' +
  'border-radius: 0px;\r\n' +
  'position: static;\r\n' +
  'z-index: auto;\r\n' +
  'display: flex;\r\n' +
  'align-items: center;\r\n' +
  'column-gap: 10px;\r\n' +
  'min-width: 0;\r\n' +
  'min-height: 16px;\r\n' +
  '}\r\n' +
  '.statistics div:last-child{\r\n' +
  'border-bottom: none;\r\n' +
  '}';

/** Separate, fixed-size (until expanded) panel for the raw Data JSON —
 * split out of .statistics itself, see STATISTICS_GROUP_STYLE's comment. */
export const STATISTICS_DATA_STYLE =
  '.statistics-data{\r\n' +
  'background: rgba(15,17,21,0.78);\r\n' +
  '-webkit-backdrop-filter: blur(6px);\r\n' +
  'backdrop-filter: blur(6px);\r\n' +
  'border: 1px solid rgba(255,255,255,0.08);\r\n' +
  'border-radius: 10px;\r\n' +
  'box-shadow: 0 4px 16px rgba(0,0,0,0.35);\r\n' +
  'color: #E8EAED;\r\n' +
  'padding: 4px 10px;\r\n' +
  'font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;\r\n' +
  'font-size: 10px;\r\n' +
  'min-width: 18em;\r\n' +
  'max-width: 26em;\r\n' +
  '}\r\n' +
  '.statistics-data .statistics-data-toggle{\r\n' +
  'display: flex;\r\n' +
  'align-items: center;\r\n' +
  'justify-content: space-between;\r\n' +
  'cursor: pointer;\r\n' +
  'user-select: none;\r\n' +
  'color: #9AA7B4;\r\n' +
  'font-weight: 600;\r\n' +
  'letter-spacing: 0.2px;\r\n' +
  'padding: 3px 0px;\r\n' +
  '}\r\n' +
  '.statistics-data .statistics-data-content{\r\n' +
  'display: none;\r\n' +
  'padding: 4px 0px 2px 0px;\r\n' +
  'white-space: normal;\r\n' +
  'word-break: break-word;\r\n' +
  'color: #E8EAED;\r\n' +
  'max-height: 30vh;\r\n' +
  'overflow-y: auto;\r\n' +
  '}\r\n' +
  '.statistics-data.expanded .statistics-data-content{\r\n' +
  'display: block;\r\n' +
  '}';

export const STATISTICS_SPAN_STYLE =
  '.statistics span{\r\n' +
  'border: 0px;\r\n' +
  'margin: 0px;\r\n' +
  'padding: 0px;\r\n' +
  'background: transparent;\r\n' +
  'font-size: 10px;\r\n' +
  'font-family: inherit;\r\n' +
  'text-align: right;\r\n' +
  'border-radius: 0px;\r\n' +
  'color: #E8EAED;\r\n' +
  'position: static;\r\n' +
  'z-index: auto;\r\n' +
  'min-width: 0;\r\n' +
  'min-height: 0;\r\n' +
  '}\r\n' +
  '.statistics .stat-label{\r\n' +
  'flex: 0 0 auto;\r\n' +
  'min-width: 60px;\r\n' +
  'text-align: left;\r\n' +
  'font-weight: 600;\r\n' +
  'letter-spacing: 0.2px;\r\n' +
  '}\r\n' +
  '.statistics .stat-value{\r\n' +
  'flex: 1 1 auto;\r\n' +
  'min-width: 0;\r\n' +
  'overflow: hidden;\r\n' +
  'text-overflow: ellipsis;\r\n' +
  'white-space: nowrap;\r\n' +
  'font-variant-numeric: tabular-nums;\r\n' +
  '}\r\n' +
  '.statistics .stat-value.wrap{\r\n' +
  'white-space: normal;\r\n' +
  'overflow: visible;\r\n' +
  'text-overflow: clip;\r\n' +
  'text-align: left;\r\n' +
  'word-break: break-word;\r\n' +
  '}\r\n' +
  '.statistics .stat-values{\r\n' +
  'display: flex;\r\n' +
  'align-items: baseline;\r\n' +
  'flex: 1 1 auto;\r\n' +
  'min-width: 0;\r\n' +
  'column-gap: 10px;\r\n' +
  '}\r\n' +
  '.statistics .stat-values .stat-value{\r\n' +
  'flex: 1 1 0;\r\n' +
  '}\r\n' +
  '.statistics .stat-values .stat-value:last-child{\r\n' +
  'color: #9AA7B4;\r\n' +
  'font-size: 10px;\r\n' +
  '}\r\n' +
  '.statistics .accent-cyan{ color: #5DD8E8; }\r\n' +
  '.statistics .accent-mint{ color: #5FDE9A; }\r\n' +
  '.statistics .accent-amber{ color: #FFB454; }\r\n' +
  '.statistics .accent-blue{ color: #6EA8FF; }\r\n' +
  '.statistics .accent-pink{ color: #FF6FB5; }\r\n' +
  '.statistics .accent-slate{ color: #9AA7B4; }\r\n' +
  '.statistics .stat-values-sm{\r\n' +
  'font-size: 9px;\r\n' +
  'color: #9AA7B4;\r\n' +
  '}\r\n' +
  '.statistics .stat-values-sm .stat-value:last-child{\r\n' +
  'font-size: 9px;\r\n' +
  '}';

/** Rolling-history "intensity graph" (bar chart, e.g. received bitrate) and
 * "line chart" (e.g. buffer/latency) mini-visualizations added to the
 * statistics panel — flat, non-animated styling to match the rest of the
 * panel's plain accent-color convention, unlike the pulsing/glowing
 * standalone network-state ball (NETWORK_STATE_WRAPPER_STYLE/BALL_STYLE
 * below), which is a separate, more attention-grabbing floating badge. */
export const STATISTICS_GRAPH_STYLE =
  '.statistics .stat-graph{\r\n' +
  'display: flex;\r\n' +
  'align-items: stretch;\r\n' +
  'flex: 1 1 auto;\r\n' +
  'height: 14px;\r\n' +
  'gap: 0;\r\n' +
  '}\r\n' +
  // Intensity graph: every cell is the same full-height rectangle — value
  // is encoded as color intensity (opacity), not height, and the strip of
  // cells left-to-right is a timeline (oldest to newest, same rolling
  // window renderIntensityGraph()'s history array already keeps).
  '.statistics .stat-graph-bar{\r\n' +
  'flex: 1 1 0;\r\n' +
  'min-width: 1px;\r\n' +
  'height: 100%;\r\n' +
  'background: #6EA8FF;\r\n' +
  'border-radius: 0;\r\n' +
  'transition: opacity 0.2s ease-out;\r\n' +
  '}\r\n' +
  '.statistics .stat-chart{\r\n' +
  'flex: 1 1 auto;\r\n' +
  'height: 14px;\r\n' +
  'display: block;\r\n' +
  'overflow: visible;\r\n' +
  '}\r\n' +
  '.statistics .stat-chart.stat-chart-sm{ height: 10px; }\r\n' +
  '.statistics .stat-chart polyline{\r\n' +
  'fill: none;\r\n' +
  'stroke: #FF6FB5;\r\n' +
  'stroke-width: 1.5;\r\n' +
  'stroke-linejoin: round;\r\n' +
  'stroke-linecap: round;\r\n' +
  '}\r\n' +
  '.statistics .stat-chart.chart-mint polyline{ stroke: #5FDE9A; }\r\n' +
  '.statistics .stat-chart.chart-amber polyline{ stroke: #FFB454; }\r\n' +
  '.statistics .stat-chart.chart-blue polyline{ stroke: #6EA8FF; }\r\n' +
  // Network variance chart: colored dynamically per current network state
  // (same 5-color mapping as .network-dot.state-* below) instead of one of
  // the fixed accent colors above.
  '.statistics .stat-chart polyline.state-poor{ stroke: #FF5A5A; }\r\n' +
  '.statistics .stat-chart polyline.state-fair{ stroke: #FFB454; }\r\n' +
  '.statistics .stat-chart polyline.state-good{ stroke: #F5D76E; }\r\n' +
  '.statistics .stat-chart polyline.state-very_good{ stroke: #9ACD32; }\r\n' +
  '.statistics .stat-chart polyline.state-excellent{ stroke: #5FDE9A; }\r\n' +
  '.statistics .stat-graph-column{\r\n' +
  'display: flex;\r\n' +
  'flex-direction: column;\r\n' +
  'row-gap: 2px;\r\n' +
  'overflow: visible;\r\n' +
  'white-space: normal;\r\n' +
  '}\r\n' +
  // Smaller intensity graph for rows where the graph sits below the text
  // rather than being the row's primary content (Drops/Latency, per
  // explicit request) — same cells/rendering, just a shorter strip.
  '.statistics .stat-graph-sm{ height: 6px; }\r\n' +
  '.statistics .network-dot{\r\n' +
  'width: 8px;\r\n' +
  'height: 8px;\r\n' +
  'border-radius: 50%;\r\n' +
  'flex: 0 0 auto;\r\n' +
  'margin-right: 6px;\r\n' +
  '}\r\n' +
  '.statistics .network-dot.state-poor{ background: #FF5A5A; }\r\n' +
  '.statistics .network-dot.state-fair{ background: #FFB454; }\r\n' +
  '.statistics .network-dot.state-good{ background: #F5D76E; }\r\n' +
  '.statistics .network-dot.state-very_good{ background: #9ACD32; }\r\n' +
  '.statistics .network-dot.state-excellent{ background: #5FDE9A; }\r\n' +
  '.statistics .network-label-row{\r\n' +
  'display: flex;\r\n' +
  'align-items: center;\r\n' +
  '}';

export const NETWORK_STATE_WRAPPER_STYLE =
  // reference from: https://codepen.io/anon/pen/RzJNqM
  '.network_state_wrapper {\r\n' +
  'bottom: 10px;\r\n' +
  'right: 1px;\r\n' +
  'display: flex;\r\n' +
  'justify-content: center;\r\n' +
  'align-items: center;\r\n' +
  'position: absolute;\r\n' +
  'transition: transform .5s;\r\n' +
  '}';

export const BALL_STYLE = '.ball {\r\n' + 'width: 10px;\r\n' + 'height: 10px;\r\n' + 'border-radius: 3px;\r\n' + 'margin: 0 4px;\r\n' + '}';

export const BALL_HOVER_STYLE = '.ball:hover {\r\n' + 'transform: scale(1.5);\r\n' + 'z-index: 1000;\r\n' + '}';

function networkDotKeyframe(prefix: '-webkit-' | '-moz-', name: string, startRgb: string, endShadowRgb: string, startShadowRgb: string): string {
  return (
    `@${prefix}keyframes ${name} {\r\n` +
    '  0% {\r\n' +
    `    background: rgba(${startRgb},1);\r\n` +
    `    box-shadow: inset 0px 0px 10px 2px rgba(${startShadowRgb},0.5),\r\n` +
    `                      0px 0px 40px 2px rgba(${endShadowRgb},1);\r\n` +
    '  }\r\n' +
    '  100% {\r\n' +
    `    background: rgba(${startRgb},0);\r\n` +
    `    box-shadow: inset 0px 0px 10px 2px rgba(${startShadowRgb},0.5),\r\n` +
    `                      0px 0px 30px 2px rgba(${endShadowRgb},0.3);\r\n` +
    '  }\r\n' +
    '}'
  );
}

// Each pair below is ported verbatim (including each color's own inline typos,
// e.g. darkred's "128,2,2" shadow / "128,20,2" glow, green's asymmetric
// "69,128,69"/"60,128,60" pairing, and moz-red's stray "61289,90,69" digit
// group) — these keyframes are cosmetic-only and never asserted on by any
// caller, so the exact RGB text is preserved rather than "corrected".
export const NETWORK_DOT_KEYFRAMES: Record<string, { webkit: string; moz: string }> = {
  darkred: {
    webkit: networkDotKeyframe('-webkit-', 'darkred', '150,0,0', '128,20,2', '128,2,2'),
    moz: networkDotKeyframe('-moz-', 'darkred', '150,0,0', '128,20,2', '128,2,2')
  },
  red: {
    webkit: networkDotKeyframe('-webkit-', 'red', '255,0,0', '255,84,60', '255,90,69'),
    moz:
      '@-moz-keyframes red {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(255,0,0,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(128,90,69,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(128,84,60,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      '    background: rgba(255,0,0,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(61289,90,69,0.5),\r\n' +
      '                      0px 0px 30px 2px rgba(128,84,60,0.3);\r\n' +
      '  }\r\n' +
      '}'
  },
  lightgreen: {
    webkit:
      '@-webkit-keyframes lightgreen {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(197,245,66,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(132,245,66,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(132,181,66,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      '    background: rgba(197,245,66,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(132,155,108,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(132,181,66,1);\r\n' +
      '  }\r\n' +
      '}',
    moz:
      '@-moz-keyframes lightgreen {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(197,245,66,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(132,245,66,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(132,181,66,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      '    background: rgba(197,245,66,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(132,155,108,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(132,181,66,1);\r\n' +
      '  }\r\n' +
      '}'
  },
  yellowgreen: {
    webkit:
      '@-webkit-keyframes yellowgreen {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(227,252,114,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(241,250,200,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(241,250,190,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      '    background: rgba(227,252,114,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(241,250,200,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(241,250,190,1);\r\n' +
      '  }\r\n' +
      '}',
    moz:
      '@-moz-keyframes yellowgreen {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(227,252,114,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(241,250,200,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(241,250,190,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      '    background: rgba(227,252,114,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(132,250,200,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(241,250,190,1);\r\n' +
      '  }\r\n' +
      '}'
  },
  green: {
    webkit: networkDotKeyframe('-webkit-', 'green', '0,255,0', '60,128,60', '69,128,69'),
    moz: networkDotKeyframe('-moz-', 'green', '0,255,0', '60,128,60', '69,128,69')
  },
  yellow: {
    webkit: networkDotKeyframe('-webkit-', 'yellow', '255,255,0', '128,128,60', '128,128,69'),
    moz:
      '@-moz-keyframes yellow {\r\n' +
      '  0% {\r\n' +
      '    background: rgba(255,255,0,1);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(128,128,69,0.5),\r\n' +
      '                      0px 0px 40px 2px rgba(128,128,60,1);\r\n' +
      '  }\r\n' +
      '  100% {\r\n' +
      // NOTE: real legacy bug preserved — the "100%" background here is
      // "rgba(0,255,0,0)" (green), copy-pasted from the green keyframe,
      // not "rgba(255,255,0,0)" like every other color's own 100% stop.
      '    background: rgba(0,255,0,0);\r\n' +
      '    box-shadow: inset 0px 0px 10px 2px rgba(128,128,69,0.5),\r\n' +
      '                      0px 0px 30px 2px rgba(128,128,60,0.3);\r\n' +
      '  }\r\n' +
      '}'
  },
  orange: {
    webkit: networkDotKeyframe('-webkit-', 'orange', '243,115,33', '251,181,132', '248,155,108'),
    moz: networkDotKeyframe('-moz-', 'orange', '243,115,33', '251,181,132', '248,155,108')
  }
};

function darkBallAnimationStyle(name: string): string {
  return `.${name} {\r\n` + 'background-color: #666666;\r\n' + `-webkit-animation: ${name} 0.5s alternate infinite;` + `-moz-animation: ${name} 0.5s alternate infinite;` + '}';
}

export const DARK_BALL_ANIMATION_STYLES: Record<'darkred' | 'red' | 'yellow' | 'lightgreen' | 'yellowgreen', string> = {
  darkred: darkBallAnimationStyle('darkred'),
  red: darkBallAnimationStyle('red'),
  yellow: darkBallAnimationStyle('yellow'),
  lightgreen: darkBallAnimationStyle('lightgreen'),
  yellowgreen: darkBallAnimationStyle('yellowgreen')
};

export const CONTEXT_MENU_STYLE =
  '.menu {\r\n' +
  'min-width: 190px;\r\n' +
  'margin: 0;\r\n' +
  'padding: 6px;\r\n' +
  'box-sizing: border-box;\r\n' +
  'z-index: 1000;\r\n' +
  'position: absolute;\r\n' +
  'display: none;\r\n' +
  'background: rgba(28, 28, 32, 0.92);\r\n' +
  'backdrop-filter: blur(8px);\r\n' +
  '-webkit-backdrop-filter: blur(8px);\r\n' +
  'border: 1px solid rgba(255, 255, 255, 0.08);\r\n' +
  'border-radius: 10px;\r\n' +
  'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.25);\r\n' +
  'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\r\n' +
  '}';

export const CONTEXT_MENU_OPTIONS_STYLE =
  '.menu .menu-options {\r\n' +
  '  list-style: none;\r\n' +
  '  margin: 0;\r\n' +
  '  padding: 0;\r\n' +
  '  display: flex;\r\n' +
  '  flex-direction: column;\r\n' +
  '  row-gap: 2px;\r\n' +
  '  z-index: 1000;\r\n' +
  '}';

export const CONTEXT_MENU_OPTION_STYLE =
  '.menu .menu-options .menu-option {\r\n' +
  '    color: #E8E8EA;\r\n' +
  '    z-index: 10000;\r\n' +
  '    font-size: 13px;\r\n' +
  '    line-height: 1.4;\r\n' +
  '    padding: 8px 12px;\r\n' +
  '    border-radius: 6px;\r\n' +
  '    cursor: pointer;\r\n' +
  '    font-style: normal;\r\n' +
  '    user-select: none;\r\n' +
  '    transition: background-color 0.12s ease-out, color 0.12s ease-out;\r\n' +
  '}';

export const CONTEXT_MENU_OPTION_HOVER_STYLE =
  '.menu .menu-options .menu-option:hover{\r\n' + '    color: #FFFFFF;\r\n' + '    background: rgba(255, 255, 255, 0.12);\r\n' + '}';

export const CONTEXT_MENU_BUTTON_STYLE =
  '.menu .menu-options .button {\r\n' +
  'background: transparent;\r\n' +
  'border: none;\r\n' +
  '}\r\n' +
  '.menu .menu-options .button:active {\r\n' +
  'background: rgba(255, 255, 255, 0.18);\r\n' +
  '}';

export const VIDEO_CONTAINER_STYLE = '.video-container {\r\n' + 'position: absolute;\r\n' + 'overflow: hidden;\r\n' + 'width: 100%;\r\n' + 'height: 100%;\r\n' + '}';

export const VIDEO_FORWARD_NOTIFY_STYLE =
  '.video-container .video-forward-notify{\r\n' +
  'text-align: center;\r\n' +
  'width:100%;\r\n' +
  'height:200%;\r\n' +
  'border-radius:100% 0 0 100%;\r\n' +
  'position: absolute;\r\n' +
  'display:flex;\r\n' +
  'flex-direction: row;\r\n' +
  'right: -50%;\r\n' +
  'top:-50%;\r\n' +
  '}';

export const VIDEO_FORWARD_NOTIFY_ICON_STYLE =
  '.video-container .video-forward-notify .icon{\r\n' + 'justify-content:flex-start;\r\n' + 'align-items:center;\r\n' + 'margin: auto 0 auto 15%;\r\n' + 'color: rgba(255,255,255, 1);\r\n' + '}';

export const VIDEO_REWIND_NOTIFY_STYLE =
  '.video-container .video-rewind-notify{\r\n' +
  'text-align: center;\r\n' +
  'width:100%;\r\n' +
  'height:200%;\r\n' +
  'border-radius:0 100% 100% 0;\r\n' +
  'position: absolute;\r\n' +
  'display:flex;\r\n' +
  'flex-direction: row;\r\n' +
  'left: -50%;\r\n' +
  'top:-50%;\r\n' +
  '}';

export const VIDEO_REWIND_NOTIFY_ICON_STYLE =
  '.video-container .video-rewind-notify .icon{\r\n' + 'justify-content:flex-start;\r\n' + 'align-items:center;\r\n' + 'margin: auto 0 auto 75%;\r\n' + 'color: rgba(255,255,255, 1);\r\n' + '}';

export const VIDEO_CONTAINER_ICON_I_STYLE = '.video-container .icon i{\r\n' + 'display:block;\r\n' + '}';

export const VIDEO_CONTAINER_SPAN_STYLE = '.video-container span{\r\n' + 'font-size:12px;\r\n' + '}';

export const VIDEO_CONTAINER_NOTIFICATION_STYLE =
  '.video-container .notification{\r\n' +
  'transition: background 0.8s;\r\n' +
  'background: rgba(200,200,200,.4) radial-gradient(circle, transparent 1%, rgba(200,200,200,.4) 1%) center/15000%;\r\n' +
  'pointer-events:none;\r\n' +
  'display: none;\r\n' +
  '}';

export const VIDEO_CONTAINER_I_STYLE = '.video-container i{\r\n' + 'font-style:normal;\r\n' + '}';

export const VIDEO_CONTAINER_SPAN_FONT_STYLE = '.video-container span{\r\n' + 'font-size:12px;\r\n' + '}';

export const VIDEO_CONTAINER_ANIMATE_IN_STYLE = '.video-container .animate-in{\r\n' + 'display:flex;\r\n' + 'animation: ripple 1s forwards;\r\n' + '}';

export const VIDEO_CONTAINER_ANIMATE_IN_I_STYLE = '.video-container .animate-in i{\r\n' + 'display:block;\r\n' + '}';

export const VIDEO_CONTAINER_ANIMATE_IN_FORWARD_I_PADDING_STYLE = '.video-container .animate-in .forward i{\r\n' + 'padding-bottom:2px;\r\n' + '}';

export const VIDEO_CONTAINER_ANIMATE_IN_FORWARD_I_ANIM_STYLE = '.video-container .animate-in .forward i{\r\n' + 'animation: fadeInLeft 0.7s;\r\n' + '}';

export const VIDEO_CONTAINER_ANIMATE_IN_REWIND_I_ANIM_STYLE = '.video-container .animate-in .rewind i{\r\n' + 'animation: fadeInRight 0.7s;\r\n' + '}';

export const RIPPLE_KEYFRAMES =
  '@keyframes ripple {\r\n' +
  '0%   {\r\n' +
  '  background-color: rgba(200,200,200,.4);\r\n' +
  '  background-size: 100%;\r\n' +
  '  transition: background 0s;\r\n' +
  '  opacity:1;\r\n' +
  '}\r\n' +
  '100% { \r\n' +
  'transition: background 0.8s;\r\n' +
  'background: rgba(200,200,200,.4) radial-gradient(circle, transparent 1%, rgba(200,200,200,.4) 1%) center/15000%;\r\n' +
  'display: flex;\r\n' +
  '  opacity:0;\r\n' +
  '}\r\n' +
  '}';

export const FADE_IN_LEFT_KEYFRAMES =
  '@keyframes fadeInLeft {\r\n' +
  '0% {\r\n' +
  '  opacity: 0;\r\n' +
  '  transform: translateX(-20px);\r\n' +
  '}\r\n' +
  '100% {\r\n' +
  '  opacity: 1;\r\n' +
  '  transform: translateX(0);\r\n' +
  '}\r\n' +
  '}';

export const FADE_IN_RIGHT_KEYFRAMES =
  '@keyframes fadeInRight {\r\n' +
  '0% {\r\n' +
  '  opacity: 0;\r\n' +
  '  transform: translateX(0px);\r\n' +
  '}\r\n' +
  '100% {\r\n' +
  '  opacity: 1;\r\n' +
  '  transform: translateX(-20px);\r\n' +
  '}\r\n' +
  '}';

export function minimapStyle(styleHeight: number): string {
  return (
    '.minimap {\r\n' +
    'position: absolute;\r\n' +
    'background: rgba(28,28,28,0.5);\r\n' +
    'border: 2px dotted #ff6633;\r\n' +
    'border-radius: 4px;\r\n' +
    'color: #fff;\r\n' +
    'right: 10px;\r\n' +
    'top: 10px;\r\n' +
    'width: 150px;\r\n' +
    `height: ${styleHeight}px;\r\n` +
    '}'
  );
}

// Legacy bug preserved: both the "@-webkit-keyframes fadeOut" check branch AND
// the "@keyframes fadeOut" check branch append the SAME webkit-prefixed rule
// text (copy-paste of the first block) — the unprefixed `@keyframes fadeOut`
// is never actually defined. See updateMetaImage()'s doc comment.
export const FADE_OUT_KEYFRAMES_WEBKIT = '@-webkit-keyframes fadeOut {\r\n' + '0% {opacity: 1;}\r\n' + '100% {opacity: 0;}\r\n' + '}';

export const FADE_OUT_STYLE = '.fadeOut {\r\n' + '-webkit-animation-name: fadeOut;\r\n' + 'animation-name: fadeOut;\r\n' + '}';

export function metaImageStyle(styleWidth: number, styleHeight: number): string {
  return (
    '.metaImage {\r\n' +
    'position: absolute;\r\n' +
    'background: rgba(28,28,28,0.5);\r\n' +
    'border: 2px dotted #ff6633;\r\n' +
    'border-radius: 4px;\r\n' +
    'color: #fff;\r\n' +
    'right: 10px;\r\n' +
    'top: 10px;\r\n' +
    '-webkit-animation-duration: 5s;animation-duration: 5s;\r\n' +
    '-webkit-animation-fill-mode: both;animation-fill-mode: both;\r\n' +
    `width: ${styleWidth}px;\r\n` +
    `height: ${styleHeight}px;\r\n` +
    '}'
  );
}

export const LOADER_STYLE =
  '.loader {\r\n' +
  'position: absolute;\r\n' +
  'top: calc(50% - 25px);\r\n' +
  'left: calc(50% - 25px);\r\n' +
  'border: 5px solid #000000;\r\n' +
  'border-radius: 50%;\r\n' +
  'border-top: 5px solid #F37321;\r\n' +
  'width: 50px;\r\n' +
  'height: 50px;\r\n' +
  '-webkit-animation: spin 2s linear infinite;\r\n' +
  'animation: spin 2s linear infinite;\r\n' +
  '}\r\n' +
  '@-webkit-keyframes spin {\r\n' +
  '0% { -webkit-transform: rotate(0deg); }\r\n' +
  '100% { -webkit-transform: rotate(360deg); }\r\n' +
  '}\r\n' +
  '@keyframes spin {\r\n' +
  '0% { transform: rotate(0deg); }\r\n' +
  '100% { transform: rotate(360deg); }\r\n' +
  '}';
