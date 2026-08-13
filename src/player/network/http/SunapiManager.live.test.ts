// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SunapiManager } from './SunapiManager';
import { loadEnv } from './loadEnv';

/**
 * Manual/local-only smoke test against a real camera on the tester's LAN.
 * Skipped by default — it needs network access to a specific device and
 * will just fail (timeout/connection refused) anywhere else (CI, other
 * machines). Opt in by supplying the device's own credentials, either via
 * the repo-root `.env` (copy `.env.example` to `.env` — see the
 * RTSP_LIVE_TEST_* entries there) or real environment variables (these
 * always win over `.env`, matching loadEnv()'s usual convention). Never
 * hardcode a real device's credentials directly in this file — it's
 * committed to source control.
 *
 *   # .env (once):
 *   RUN_LIVE_DEVICE_TEST=1
 *   RTSP_LIVE_TEST_HOSTNAME=192.168.x.x
 *   RTSP_LIVE_TEST_USERNAME=admin
 *   RTSP_LIVE_TEST_PASSWORD=...
 *
 *   npx vitest run SunapiManager.live.test.ts
 *
 *   # or, without touching .env:
 *   RUN_LIVE_DEVICE_TEST=1 RTSP_LIVE_TEST_HOSTNAME=192.168.x.x \
 *   RTSP_LIVE_TEST_USERNAME=admin RTSP_LIVE_TEST_PASSWORD=... \
 *   npx vitest run SunapiManager.live.test.ts
 *
 * RTSP_LIVE_TEST_PORT (default 443) and RTSP_LIVE_TEST_PROTOCOL (default
 * https) are optional overrides for non-default devices.
 *
 * `@vitest-environment jsdom` (overriding this project's default `node`
 * environment for this file only) is needed because `SunapiClient` talks to
 * the device via the browser `XMLHttpRequest` global, which only jsdom
 * provides.
 */
loadEnv();

// `describe.skip(name, fn)` still calls `fn()` synchronously during test
// collection (that's how it discovers the `it()`s inside to report as
// skipped) — only the `it()` bodies themselves are skipped. So the
// credentials guard below must itself be gated on `runLive`, not just
// wrapped in `describeLive`/`describe.skip` — otherwise it throws during
// collection on every `npm run test:player` run everywhere credentials
// aren't set (i.e. everywhere except a deliberately-configured local
// machine), defeating the entire "skipped by default" point of this file.
const runLive = process.env.RUN_LIVE_DEVICE_TEST === '1';
const describeLive = runLive ? describe : describe.skip;

describeLive('SunapiManager against a real device (manual)', () => {
  // The device uses a self-signed TLS certificate; Node's default HTTPS
  // client (which jsdom's XHR implementation delegates to) rejects that
  // unless certificate validation is disabled. Local/manual testing only —
  // never do this in production code.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const hostname = process.env.RTSP_LIVE_TEST_HOSTNAME ?? '';
  const username = process.env.RTSP_LIVE_TEST_USERNAME ?? '';
  const password = process.env.RTSP_LIVE_TEST_PASSWORD ?? '';
  if (runLive && (!hostname || !username || !password)) {
    throw new Error(
      'RUN_LIVE_DEVICE_TEST=1 requires RTSP_LIVE_TEST_HOSTNAME/RTSP_LIVE_TEST_USERNAME/RTSP_LIVE_TEST_PASSWORD to be set — see this file\'s top comment.'
    );
  }

  const deviceInfo = {
    ClientIPAddress: '127.0.0.1',
    hostname,
    cameraIp: hostname,
    username,
    user: username,
    password,
    port: Number(process.env.RTSP_LIVE_TEST_PORT ?? 443),
    protocol: process.env.RTSP_LIVE_TEST_PROTOCOL ?? 'https',
    deviceType: 'camera',
    serverType: 'grunt',
    timeout: 10000,
    debug: true,
    async: false
  };

  it('logs in via SUNAPI (attributes.cgi) and reports the response shape', async () => {
    const manager = new SunapiManager();
    const response = await manager.init(deviceInfo);
    // eslint-disable-next-line no-console
    console.log('attributes.cgi (login) response type:', typeof response, '\nvalue:', response);
    expect(response).toBeDefined();
  }, 20000);

  it('fetches /stw-cgi/attributes.cgi/attributes and reports whether it is XML or JSON', async () => {
    const manager = new SunapiManager();
    await manager.init(deviceInfo);
    const attributes = await manager.getAttributes();
    const looksLikeXml = typeof attributes === 'string' && attributes.trim().startsWith('<');
    // eslint-disable-next-line no-console
    console.log('getAttributes() response type:', typeof attributes, 'looksLikeXml:', looksLikeXml, '\nvalue:', attributes);
    expect(attributes).toBeDefined();
  }, 20000);
});
