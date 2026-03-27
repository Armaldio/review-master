import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { simpleGit, SimpleGit } from 'simple-git';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  ipcMain.handle('get-app-path', () => {
    return app.getPath('userData');
  });

  ipcMain.handle('read-file', async (event, filePath: string) => {
    // console.log(`[IPC:read-file] Reading file: ${filePath}`); // Disabled to avoid being too spammy
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, content };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('clone-repo', async (event, repoUrl: string, targetPath: string) => {
    console.log(`[IPC:clone-repo] Starting clone/fetch for: ${repoUrl}`);
    console.log(`[IPC:clone-repo] Target path: ${targetPath}`);
    try {
      // Create directory if it doesn't exist
      await fs.mkdir(targetPath, { recursive: true });

      const git: SimpleGit = simpleGit({
        baseDir: targetPath,
        progress({ method, stage, progress }) {
            console.log(`[IPC:clone-repo] git ${method} - ${stage} stage ${progress}% complete`);
        }
      });

      // Check if it's already a git repo
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        console.log(`[IPC:clone-repo] Repository not found locally. Cloning...`);
        await git.clone(repoUrl, targetPath, ['--progress']);
        console.log(`[IPC:clone-repo] Clone completed successfully.`);
      } else {
        console.log(`[IPC:clone-repo] Existing repository found. Fetching updates...`);
        await git.fetch(['--progress']);
        console.log(`[IPC:clone-repo] Fetch completed successfully.`);
      }

      return { success: true };
    } catch (error) {
      console.error('Error cloning repo:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // --- Keyring IPC Handlers ---
  const SERVICE_NAME = 'review-master';
  const { setPassword, getPassword, deletePassword } = require('@napi-rs/keyring');

  ipcMain.handle('set-secret', async (event, account: string, value: string) => {
    try {
      await setPassword(SERVICE_NAME, account, value);
      return { success: true };
    } catch (error: any) {
      console.error(`[Keyring] Failed to set secret for ${account}:`, error);
      // Check for common ServiceUnknown error
      if (error.message?.includes('ServiceUnknown') || error.message?.includes('not activatable')) {
        return { success: false, error: 'ERR_NO_SECRET_SERVICE', message: error.message };
      }
      return { success: false, error: 'ERR_KEYRING_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('get-secret', async (event, account: string) => {
    try {
      const password = await getPassword(SERVICE_NAME, account);
      return { success: true, value: password };
    } catch (error: any) {
      // If service is missing
      if (error.message?.includes('ServiceUnknown') || error.message?.includes('not activatable')) {
        return { success: false, error: 'ERR_NO_SECRET_SERVICE', message: error.message };
      }
      // Keyring often throws if not found, we treat it as successfully returning null
      return { success: true, value: null };
    }
  });

  ipcMain.handle('delete-secret', async (event, account: string) => {
    try {
      await deletePassword(SERVICE_NAME, account);
      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('ServiceUnknown') || error.message?.includes('not activatable')) {
        return { success: false, error: 'ERR_NO_SECRET_SERVICE', message: error.message };
      }
      return { success: false, error: 'ERR_KEYRING_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('check-keyring', async () => {
    try {
      // Try to get a dummy value to trigger a check
      await getPassword(SERVICE_NAME, 'check-health');
      return { success: true };
    } catch (error: any) {
      if (error.message?.includes('ServiceUnknown') || error.message?.includes('not activatable')) {
        return { success: false, error: 'ERR_NO_SECRET_SERVICE', message: error.message };
      }
      // If it's just "not found", the service IS alive
      return { success: true };
    }
  });

  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
