import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } from 'electron';
import { parse, matchFile } from 'codeowners-utils';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { simpleGit, SimpleGit } from 'simple-git';
import started from 'electron-squirrel-startup';
import { exec, spawn } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

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
  
  return mainWindow;
};

const checkForUpdates = () => {
  const options = {
    hostname: 'api.github.com',
    path: '/repos/Armaldio/review-master/releases/latest',
    headers: {
      'User-Agent': 'review-master-app'
    }
  };

  https.get(options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const release = JSON.parse(data);
        const latestVersion = release.tag_name.replace(/^v/, '');
        const currentVersion = app.getVersion();

        if (latestVersion !== currentVersion) {
          dialog.showMessageBox({
            type: 'info',
            title: 'Update Available',
            message: `A new version (${release.tag_name}) is available. Would you like to download it?`,
            buttons: ['Download', 'Later']
          }).then((result) => {
            if (result.response === 0) {
              shell.openExternal(release.html_url);
            }
          });
        }
      } catch (e) {
        console.error('[UpdateCheck] Failed to parse latest release:', e);
      }
    });
  }).on('error', (err) => {
    console.error('[UpdateCheck] Error:', err);
  });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  createWindow();
  checkForUpdates();

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
  console.log(`[Secrets] Storage file path: ${SECRETS_FILE}`);

  async function readSecrets() {
    try {
      const data = await fs.readFile(SECRETS_FILE, 'utf-8');
      if (!data) return {};
      return JSON.parse(data);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.error(`[Secrets] Error reading secrets file:`, error.message);
      }
      return {};
    }
  }

  async function writeSecrets(secrets: Record<string, string>) {
    try {
      await fs.mkdir(path.dirname(SECRETS_FILE), { recursive: true });
      await fs.writeFile(SECRETS_FILE, JSON.stringify(secrets, null, 2));
      console.log(`[Secrets] Successfully wrote secrets to file`);
    } catch (error: any) {
      console.error(`[Secrets] Error writing secrets file:`, error.message);
      throw error;
    }
  }

  ipcMain.handle('set-secret', async (event, account: string, value: string) => {
    console.log(`[Secrets] Attempting to set secret for: ${account}`);
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn(`[Secrets] safeStorage is NOT available on this system. Falling back to frontend localStorage.`);
        return { success: false, error: 'ERR_ENCRYPTION_UNAVAILABLE', message: 'Encryption is not available on this system' };
      }
      
      console.log(`[Secrets] safeStorage available, encrypting...`);
      const encrypted = safeStorage.encryptString(value).toString('base64');
      const secrets = await readSecrets();
      secrets[account] = encrypted;
      await writeSecrets(secrets);
      return { success: true };
    } catch (error: any) {
      console.error(`[Secrets] Failed to set secret for ${account}:`, error.message);
      return { success: false, error: 'ERR_STORAGE_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('get-secret', async (event, account: string) => {
    console.log(`[Secrets] Attempting to get secret for: ${account}`);
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        return { success: false, error: 'ERR_ENCRYPTION_UNAVAILABLE', message: 'Encryption is not available' };
      }
      const secrets = await readSecrets();
      const encrypted = secrets[account];
      if (!encrypted) {
        console.log(`[Secrets] No secret found for ${account}`);
        return { success: true, value: null };
      }

      console.log(`[Secrets] Encrypted secret found, decrypting...`);
      const decrypted = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      return { success: true, value: decrypted };
    } catch (error: any) {
      console.error(`[Secrets] Failed to get secret for ${account}:`, error.message);
      return { success: false, error: 'ERR_DECRYPTION_FAILED', message: (error as Error).message };
    }
  });

  ipcMain.handle('delete-secret', async (event, account: string) => {
    console.log(`[Secrets] Attempting to delete secret for: ${account}`);
    try {
      const secrets = await readSecrets();
      delete secrets[account];
      await writeSecrets(secrets);
      return { success: true };
    } catch (error: any) {
      console.error(`[Secrets] Failed to delete secret for ${account}:`, error.message);
      return { success: false, error: 'ERR_STORAGE_FAILED', message: (error as Error).message };
    }
  });

  // --- Binary Management (sem, difft) ---
  const BIN_DIR = path.join(app.getPath('userData'), 'bin');
  const SEM_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'sem.exe' : 'sem');
  const DIFFT_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'difft.exe' : 'difft');

  async function downloadFile(url: string, dest: string) {
    return new Promise((resolve, reject) => {
      const file = createWriteStream(dest);
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          downloadFile(response.headers.location!, dest).then(resolve).catch(reject);
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(true);
        });
      }).on('error', (err) => {
        fs.unlink(dest);
        reject(err);
      });
    });
  }

  async function initBinaries() {
    try {
      await fs.mkdir(BIN_DIR, { recursive: true });
      const stats = await fs.stat(SEM_PATH).catch(() => null);
      
      if (!stats) {
        console.log('[Binaries] sem not found, downloading...');
        const platformMap: Record<string, string> = { 'linux': 'linux', 'darwin': 'darwin', 'win32': 'windows' };
        const archMap: Record<string, string> = { 'x64': 'x86_64', 'arm64': 'arm64' };
        
        const platform = platformMap[process.platform];
        const arch = archMap[process.arch];
        
        if (!platform || !arch) {
          console.error(`[Binaries] Unsupported platform/arch: ${process.platform}/${process.arch}`);
          return;
        }

        const extension = platform === 'windows' ? 'zip' : 'tar.gz';
        const url = `https://github.com/Ataraxy-Labs/sem/releases/download/v0.3.10/sem-${platform}-${arch}.${extension}`;
        const archivePath = path.join(BIN_DIR, `sem-download.${extension}`);

        await downloadFile(url, archivePath);
        console.log(`[Binaries] Downloaded sem archive. Extracting...`);

        if (platform === 'windows') {
            // Placeholder for windows zip extraction if needed
            console.warn('[Binaries] Windows ZIP extraction not implemented yet.');
        } else {
            await execAsync(`tar -xzf "${archivePath}" -C "${BIN_DIR}"`);
            await fs.chmod(SEM_PATH, 0o755);
        }
        
        await fs.unlink(archivePath);
        console.log('[Binaries] sem installed successfully.');
      } else {
        console.log('[Binaries] sem is already installed.');
      }

      // Difftastic
      const difftStats = await fs.stat(DIFFT_PATH).catch(() => null);
      if (!difftStats) {
        console.log('[Binaries] difft not found, downloading...');
        const platformMap: Record<string, string> = { 'linux': 'unknown-linux-gnu', 'darwin': 'apple-darwin', 'win32': 'pc-windows-msvc' };
        const archMap: Record<string, string> = { 'x64': 'x86_64', 'arm64': 'aarch64' };
        
        const platform = platformMap[process.platform];
        const arch = archMap[process.arch];
        
        if (!platform || !arch) return;

        const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
        const url = `https://github.com/Wilfred/difftastic/releases/download/0.68.0/difft-${arch}-${platform}.${extension}`;
        const archivePath = path.join(BIN_DIR, `difft-download.${extension}`);

        await downloadFile(url, archivePath);
        if (process.platform === 'win32') {
          console.warn('[Binaries] Windows ZIP extraction not implemented yet for difft.');
        } else {
          await execAsync(`tar -xzf "${archivePath}" -C "${BIN_DIR}"`);
          await fs.chmod(DIFFT_PATH, 0o755);
        }
        await fs.unlink(archivePath);
        console.log('[Binaries] difft installed successfully.');
      } else {
        console.log('[Binaries] difft is already installed.');
      }
    } catch (error) {
      console.error('[Binaries] Failed to initialize binaries:', error);
    }
  }

  ipcMain.handle('run-sem', async (event, payload: any) => {
    return new Promise((resolve) => {
      console.log(`[IPC:run-sem] Running semantic diff for: ${payload.filePath}`);
      const input = JSON.stringify([payload]);
      // console.log(`[IPC:run-sem] Input: ${input}`); // Debug: uncomment if needed

      const child = spawn(SEM_PATH, ['diff', '--stdin', '--format', 'json']);
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const data = JSON.parse(stdout);
            console.log(`[IPC:run-sem] Success! Output contains ${data[0]?.entities?.length || 0} entities.`);
            resolve({ success: true, data });
          } catch (e) {
            console.error(`[IPC:run-sem] Parse error. Raw output: ${stdout}`);
            resolve({ success: false, error: 'Failed to parse sem output', raw: stdout });
          }
        } else {
          console.error(`[IPC:run-sem] Process exited with code ${code}. Stderr: ${stderr}`);
          resolve({ success: false, error: stderr || `Process exited with code ${code}`, input });
        }
      });
      
      child.stdin.write(input);
      child.stdin.end();
    });
  });

  ipcMain.handle('run-difftastic', async (event, payload: { filePath: string, beforeContent: string, afterContent: string }) => {
    const tmpDir = path.join(app.getPath('temp'), `review-master-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    
    const ext = path.extname(payload.filePath);
    const oldPath = path.join(tmpDir, `old${ext}`);
    const newPath = path.join(tmpDir, `new${ext}`);
    
    await fs.writeFile(oldPath, payload.beforeContent);
    await fs.writeFile(newPath, payload.afterContent);
    
    return new Promise((resolve) => {
      console.log(`[IPC:run-difft] Running AST diff for: ${payload.filePath}`);
      const child = spawn(DIFFT_PATH, ['--display', 'json', oldPath, newPath], {
        env: { ...process.env, DFT_UNSTABLE: 'yes' }
      });
      
      let stdout = '';
      let stderr = '';
      
      child.stdout.on('data', (data) => stdout += data);
      child.stderr.on('data', (data) => stderr += data);
      
      child.on('close', async (code) => {
        // Clean up
        await fs.rm(tmpDir, { recursive: true, force: true });
        
        if (code === 0 || code === 1) { // 1 often means differences found
          try {
            resolve({ success: true, data: JSON.parse(stdout) });
          } catch (e) {
            resolve({ success: false, error: 'Failed to parse difftastic output', raw: stdout });
          }
        } else {
          resolve({ success: false, error: stderr || `Process exited with code ${code}` });
        }
      });
    });
  });

  ipcMain.handle('check-binaries', async () => {
    const semExists = await fs.stat(SEM_PATH).then(() => true).catch(() => false);
    const difftExists = await fs.stat(DIFFT_PATH).then(() => true).catch(() => false);
    return { sem: semExists, difft: difftExists, inspect: false };
  });

  ipcMain.handle('check-storage-encryption', async () => {
    const available = safeStorage.isEncryptionAvailable();
    return { 
      success: available,
      message: available ? 'Secure storage available' : 'Secure storage is not available on this system'
    };
  });

  ipcMain.handle('open-external', async (event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('parse-codeowners', async (event, content: string) => {
    try {
      return parse(content);
    } catch (e) {
      console.error('Failed to parse CODEOWNERS:', e);
      return [];
    }
  });

  ipcMain.handle('match-codeowners', async (event, { filePath, rules }) => {
    try {
      return matchFile(filePath, rules);
    } catch (e) {
      console.error('Failed to match CODEOWNERS rule:', e);
      return null;
    }
  });

  ipcMain.handle('match-codeowners-bulk', async (event, { filePaths, rules }) => {
    try {
      const results: Record<string, string[]> = {};
      for (const filePath of filePaths) {
        const match = matchFile(filePath, rules);
        if (match) {
          results[filePath] = match.owners;
        }
      }
      return results;
    } catch (e) {
      console.error('Failed to bulk match CODEOWNERS rules:', e);
      return {};
    }
  });

  initBinaries();
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
