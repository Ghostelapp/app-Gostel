import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const HOST = '0.0.0.0';
const DIST_DIR = path.join(__dirname, 'dist');
const BACKEND_TARGET = process.env.EXPO_PUBLIC_BACKEND_URL || process.env.BACKEND_URL || 'https://api.ghostel.app';

const app = express();
const server = http.createServer(app);

// Proxy for API and WebSocket
const apiProxy = createProxyMiddleware({
  target: BACKEND_TARGET,
  changeOrigin: true,
  ws: true,
  logLevel: 'warn',
  onError(err, req, res) {
    if (res && res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Backend proxy error', message: err.message }));
    }
  },
});

app.use('/api', apiProxy);
app.use('/ws', apiProxy);

// Helper for Expo Router static html resolution
function findMatchingHtmlFile(urlPath) {
  if (!fs.existsSync(DIST_DIR)) return null;

  const cleanPath = urlPath.split('?')[0].split('#')[0];
  
  // 1. Direct file check
  const directPath = path.join(DIST_DIR, cleanPath);
  if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
    return directPath;
  }

  // 2. Direct .html check
  const htmlPath = path.join(DIST_DIR, `${cleanPath.replace(/\/$/, '')}.html`);
  if (fs.existsSync(htmlPath) && fs.statSync(htmlPath).isFile()) {
    return htmlPath;
  }

  // 3. Nested index.html check
  const indexPath = path.join(directPath, 'index.html');
  if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
    return indexPath;
  }

  // 4. Default to root index.html
  const rootIndex = path.join(DIST_DIR, 'index.html');
  if (fs.existsSync(rootIndex)) {
    return rootIndex;
  }

  return null;
}

// Serve static assets from dist
app.use(express.static(DIST_DIR, { index: false }));

// Fallback route handler for SPA / Expo Router
app.get('*', (req, res) => {
  const matchedFile = findMatchingHtmlFile(req.path);
  if (matchedFile) {
    return res.sendFile(matchedFile);
  }

  // If dist is still compiling
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ghostel Web</title>
  <style>
    body {
      margin: 0;
      background: #0f1419;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      text-align: center;
      padding: 24px;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #388bfd;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 24px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
    p { color: #8b949e; font-size: 14px; margin: 0; }
  </style>
  <script>
    setTimeout(() => window.location.reload(), 2000);
  </script>
</head>
<body>
  <div class="spinner"></div>
  <h1>Ghostel Web Client Initializing...</h1>
  <p>Exporting web bundles and preparing secure messenger interface.</p>
</body>
</html>`);
});

server.listen(PORT, HOST, () => {
  console.log(`[Ghostel Server] Running on http://${HOST}:${PORT}`);
  console.log(`[Ghostel Server] Proxying API calls to ${BACKEND_TARGET}`);
});
