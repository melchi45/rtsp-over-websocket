#!/usr/bin/env node
// Runs before src/server starts (see package.json's start:server* scripts).
// Checks the yt-dlp that a bare `which yt-dlp` resolves to; if
// ~/.local/bin/yt-dlp (the path src/server/config.ts's resolveYtDlpBinary()
// prefers over PATH lookup — see its comment) doesn't exist yet, downloads
// the latest standalone release there. Never fails the build/start: a
// missing/stale yt-dlp only breaks YouTube sessions specifically (probe/
// transcode already report that clearly on their own — see youtubeProbe.ts),
// not the server itself.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LOCAL_YT_DLP = path.join(os.homedir(), '.local', 'bin', 'yt-dlp');
const DOWNLOAD_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

function getVersion(bin) {
  try {
    return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function whichYtDlp() {
  try {
    return execFileSync('which', ['yt-dlp'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function installLocalYtDlp() {
  fs.mkdirSync(path.dirname(LOCAL_YT_DLP), { recursive: true });
  console.log(`[ensure-yt-dlp] installing latest yt-dlp to ${LOCAL_YT_DLP} ...`);
  try {
    execFileSync('curl', ['-fsSL', '-o', LOCAL_YT_DLP, DOWNLOAD_URL], { stdio: 'inherit' });
    fs.chmodSync(LOCAL_YT_DLP, 0o755);
  } catch (error) {
    console.warn(`[ensure-yt-dlp] WARNING: install failed (${error.message}) — YouTube sessions will use whatever 'yt-dlp' resolves to on PATH instead.`);
    return;
  }
  console.log(`[ensure-yt-dlp] installed yt-dlp ${getVersion(LOCAL_YT_DLP)}`);
}

const resolved = whichYtDlp();
console.log(`[ensure-yt-dlp] which yt-dlp: ${resolved || '(not found on PATH)'}${resolved ? ` (${getVersion(resolved)})` : ''}`);

if (fs.existsSync(LOCAL_YT_DLP)) {
  console.log(`[ensure-yt-dlp] ${LOCAL_YT_DLP} already present (${getVersion(LOCAL_YT_DLP)}) — src/server prefers this path regardless of PATH order, skipping install.`);
} else {
  installLocalYtDlp();
}
