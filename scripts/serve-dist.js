#!/usr/bin/env node
// Static file server for dist/ (the TypeScript/ESM rewrite build output +
// hand-written demo pages, see src/player/vite.config.ts and .gitignore).
// Serves the same directory over both HTTP and HTTPS so the demo page
// (dist/index.html) and dist/player/*.js can be exercised from a browser
// without going through the legacy grunt/connect app server.
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const CERT_DIR = path.join(ROOT_DIR, 'certs');
const CERT_KEY = path.join(CERT_DIR, 'dev-server.key');
const CERT_CRT = path.join(CERT_DIR, 'dev-server.crt');

const HTTP_PORT = Number(process.env.PLAYER_HTTP_PORT) || 4010;
const HTTPS_PORT = Number(process.env.PLAYER_HTTPS_PORT) || 4011;
const HOST = process.env.PLAYER_SERVER_HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function ensureSelfSignedCert() {
  if (fs.existsSync(CERT_KEY) && fs.existsSync(CERT_CRT)) {
    return;
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  console.log('[serve-dist] no HTTPS cert found, generating a self-signed one in certs/ ...');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', CERT_KEY,
    '-out', CERT_CRT,
    '-days', '3650',
    '-nodes',
    '-subj', '/CN=localhost'
  ], { stdio: 'inherit' });
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const resolved = path.normalize(path.join(root, decoded));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null; // path traversal attempt
  }
  return resolved;
}

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  let filePath = safeJoin(DIST_DIR, req.url === '/' ? '/index.html' : req.url);
  if (!filePath) {
    res.writeHead(400).end('Bad Request');
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (!statErr && stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  });
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`[serve-dist] dist/ not found at ${DIST_DIR} — run "npm run build:player" first.`);
    process.exit(1);
  }

  ensureSelfSignedCert();

  http.createServer(handleRequest).listen(HTTP_PORT, HOST, () => {
    console.log(`[serve-dist] HTTP  http://localhost:${HTTP_PORT}  (serving ${DIST_DIR})`);
  });

  const httpsOptions = {
    key: fs.readFileSync(CERT_KEY),
    cert: fs.readFileSync(CERT_CRT)
  };
  https.createServer(httpsOptions, handleRequest).listen(HTTPS_PORT, HOST, () => {
    console.log(`[serve-dist] HTTPS https://localhost:${HTTPS_PORT}  (serving ${DIST_DIR})`);
  });
}

main();
