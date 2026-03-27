import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
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

  // --- Secrets Storage IPC Handlers (safeStorage) ---
  const SECRETS_FILE = path.join(app.getPath('userData'), 'secrets.json');

  async function readSecrets() {
    try {
      const data = await fs.readFile(SECRETS_FILE, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  async function writeSecrets(secrets: Record<string, string>) {
    await fs.writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2));
  }

  ipcMain.handle('set-secret', async (event, account: string, value: string) => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { success: false, error: 'ERR_ENCRYPTION_UNAVAILABLE', message: 'Encryption is not available on this system' };
      }
      const encrypted = safeStorage.encryptString(value).toString('base64');
      const secrets = await readSecrets();
      secrets[account] = encrypted;
      await writeSecrets(secrets);
      return { success: true };
    } catch (error: any) {
      console.error(`[Secrets] Failed to set secret for ${account}:`, error);
      return { success: false, error: 'ERR_STORAGE_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('get-secret', async (event, account: string) => {
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { success: false, error: 'ERR_ENCRYPTION_UNAVAILABLE', message: 'Encryption is not available' };
      }
      const secrets = await readSecrets();
      const encrypted = secrets[account];
      if (!encrypted) return { success: true, value: null };

      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      return { success: true, value: decrypted };
    } catch (error: any) {
      console.error(`[Secrets] Failed to get secret for ${account}:`, error);
      return { success: false, error: 'ERR_DECRYPTION_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('delete-secret', async (event, account: string) => {
    try {
      const secrets = await readSecrets();
      delete secrets[account];
      await writeSecrets(secrets);
      return { success: true };
    } catch (error: any) {
      console.error(`[Secrets] Failed to delete secret for ${account}:`, error);
      return { success: false, error: 'ERR_STORAGE_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('check-storage-encryption', async () => {
    const available = safeStorage.isEncryptionAvailable();
    return { 
      success: available,
      message: available ? 'Secure storage available' : 'Secure storage is not available on this system'
    };
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
