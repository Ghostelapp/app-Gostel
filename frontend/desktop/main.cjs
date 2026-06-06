const { app, BrowserWindow, dialog, Menu, shell, session } = require("electron");
const { appendFileSync, createReadStream, existsSync, statSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { extname, join, normalize, resolve, sep } = require("node:path");

const APP_ORIGIN = "http://127.0.0.1";
const MIME = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
};

let server;
let appUrl;
let mainWindow;

function log(message) {
  try {
    appendFileSync(
      join(tmpdir(), "ghostel-desktop.log"),
      `${new Date().toISOString()} ${message}\n`,
    );
  } catch {
    // Logging must never prevent the app from starting.
  }
}

function debug(message) {
  if (process.env.GHOSTEL_DESKTOP_DEBUG === "1") log(message);
}

function findStaticFile(root, pathname) {
  const clean = decodeURIComponent(pathname.split("?")[0]).replace(/^\/+/, "");
  const candidates = [
    clean || "index.html",
    clean && `${clean}.html`,
    "index.html",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fullPath = resolve(root, normalize(candidate));
    if (!fullPath.startsWith(`${root}${sep}`) || !existsSync(fullPath)) continue;
    if (statSync(fullPath).isFile()) return fullPath;
  }
  return null;
}

function startStaticServer() {
  const root = resolve(__dirname, "..", "dist-web");
  server = createServer((request, response) => {
    const filePath = findStaticFile(root, request.url || "/");
    if (!filePath) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = extname(filePath).toLowerCase();
    const cacheControl = filePath.includes(`${join("_expo", "static")}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache";

    response.writeHead(200, {
      "Cache-Control": cacheControl,
      "Content-Type": MIME[extension] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  });

  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      appUrl = `${APP_ORIGIN}:${address.port}`;
      debug(`Static server ready: ${appUrl}`);
      resolveServer();
    });
  });
}

function isLocalUrl(target) {
  if (!appUrl || typeof target !== "string") return false;
  try {
    return new URL(target).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 390,
    minHeight: 640,
    show: false,
    title: "Ghostel",
    backgroundColor: "#0f1419",
    icon: join(__dirname, "..", "assets", "images", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.on("did-finish-load", () => debug("Renderer loaded"));
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    log(`Renderer failed to load (${code}): ${description}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log(`Renderer process gone: ${details.reason}`);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isLocalUrl(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isLocalUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.loadURL(appUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
debug(`Single instance lock: ${hasSingleInstanceLock}`);
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  debug("Electron ready");
  Menu.setApplicationMenu(null);

  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return isLocalUrl(requestingOrigin) && ["media", "notifications"].includes(permission);
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed =
      isLocalUrl(webContents.getURL()) &&
      ["media", "notifications"].includes(permission);
    callback(allowed);
  });

  await startStaticServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  log(`Startup failed: ${error?.stack || error}`);
  dialog.showErrorBox("Ghostel", "Nie udało się uruchomić aplikacji Ghostel.");
  app.quit();
});

process.on("uncaughtException", (error) => {
  log(`Uncaught exception: ${error?.stack || error}`);
});

process.on("unhandledRejection", (error) => {
  log(`Unhandled rejection: ${error?.stack || error}`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  server?.close();
});
