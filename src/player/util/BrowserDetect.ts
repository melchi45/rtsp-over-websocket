export type BrowserName = 'ie' | 'ie10' | 'ie11' | 'edge' | 'chrome' | 'safari' | 'firefox' | undefined;

/**
 * Ported from the legacy player’s Util/util.js (window.BrowserDetect, ~line 1335).
 * Reads `navigator.userAgent`/`navigator.appName`, so it only returns a
 * meaningful value in a real browser; callers running under Node (tests,
 * SSR) will simply get `undefined`, matching what the legacy code would do
 * if `navigator` were unexpectedly absent.
 */
export function browserDetect(): BrowserName {
  if (typeof navigator === 'undefined') {
    return undefined;
  }
  const agent = navigator.userAgent.toLowerCase();
  const name = navigator.appName;

  if (name === 'Microsoft Internet Explorer' || agent.indexOf('trident') > -1 || agent.indexOf('edge/') > -1) {
    if (name === 'Microsoft Internet Explorer') {
      const match = /msie ([0-9]{1,}[.0-9]{0,})/.exec(agent);
      return match ? (`ie${parseInt(match[1], 10)}` as BrowserName) : 'ie';
    }
    if (agent.indexOf('trident') > -1) {
      return 'ie11';
    }
    if (agent.indexOf('edge/') > -1) {
      return 'edge';
    }
    return 'ie';
  } else if (agent.indexOf('safari') > -1) {
    return agent.indexOf('chrome') > -1 ? 'chrome' : 'safari';
  } else if (agent.indexOf('firefox') > -1) {
    return 'firefox';
  }
  return undefined;
}
