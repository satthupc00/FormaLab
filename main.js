const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { initLicense, isLocked } = require("./license.js");
const { initUpdater } = require("./updater.js");

// Keeps the taskbar grouping / hover name as "Mondiro FormaLab" instead of "Electron".
// Must match build.appId in package.json.
if (process.platform === "win32") {
  app.setAppUserModelId("com.mondiro.formalab");
}
app.setName("Mondiro FormaLab");

let mainWindow;

// Remembers the window size/position between launches.
const STATE_FILE = path.join(app.getPath("userData"), "window-state.json");
const MIN_WIDTH = 1100;
const MIN_HEIGHT = 680;

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return {
      width: Math.max(s.width || 1440, MIN_WIDTH), height: Math.max(s.height || 900, MIN_HEIGHT),
      x: s.x, y: s.y, maximized: !!s.maximized,
    };
  } catch (e) {
    return { width: 1440, height: 900 };
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...mainWindow.getNormalBounds(), maximized: mainWindow.isMaximized() }));
  } catch (e) { /* not critical */ }
}

// Samples and HDRIs live next to the app: in resources/ once installed, in the repo while developing.
function resourceDir(name) {
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, name);
}

function createWindow() {
  const iconPath = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: "Mondiro FormaLab",
    backgroundColor: "#1F2126",
    // Header Mondiro la thanh tieu de; 3 nut cua so Windows nam de goc phai cung mau header
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#1F2126", symbolColor: "#FFFFFF", height: 58 },
    autoHideMenuBar: true,
    show: false,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) mainWindow.maximize();
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Links in the app open in the normal browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", e => e.preventDefault());

  let saveTimer = null;
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveWindowState, 300); };
  mainWindow.on("resize", scheduleSave);
  mainWindow.on("move", scheduleSave);
  mainWindow.on("close", saveWindowState);
}

// ---- file dialogs + paths for the renderer ----
ipcMain.handle("app-paths", () => ({
  samples: resourceDir("samples"),
  hdri: resourceDir("hdri"),
  pictures: app.getPath("pictures"),
  videos: app.getPath("videos"),
}));

ipcMain.handle("open-dialog", async (_e, opts) => {
  const res = await dialog.showOpenDialog(mainWindow, opts || {});
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("save-dialog", async (_e, opts) => {
  const res = await dialog.showSaveDialog(mainWindow, opts || {});
  return res.canceled ? null : res.filePath;
});

ipcMain.handle("show-in-folder", (_e, file) => { shell.showItemInFolder(file); });

// A model given on the command line ("Open with FormaLab" / double-click a file).
ipcMain.handle("launch-file", () => {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find(a => /\.(fbx|glb|gltf|obj)$/i.test(a));
  return arg && fs.existsSync(arg) ? path.resolve(arg) : null;
});

app.whenReady().then(() => {
  createWindow();
  initLicense(() => mainWindow);
  initUpdater(() => mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// F12 / Ctrl+Shift+I open DevTools for diagnosing on someone else's machine, but stay closed
// while the app is locked so the lock screen can't simply be deleted.
app.on("browser-window-created", (_e, win) => {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const devtools = input.key === "F12"
      || (input.control && input.shift && input.key.toLowerCase() === "i");
    if (devtools) {
      event.preventDefault();
      if (!isLocked()) win.webContents.toggleDevTools();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
