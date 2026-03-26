/// <reference types="vite/client" />

declare interface Window {
  electronAPI: {
    cloneRepo: (repoUrl: string, targetPath: string) => Promise<{ success: boolean; error?: string }>;
    getAppPath: () => Promise<string>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
  };
}