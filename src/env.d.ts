/// <reference types="vite/client" />

declare interface Window {
  electronAPI: {
    cloneRepo: (repoUrl: string, targetPath: string) => Promise<{ success: boolean; error?: string }>;
    getAppPath: () => Promise<string>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    setSecret: (account: string, value: string) => Promise<{ success: boolean; error?: string; message?: string }>;
    getSecret: (account: string) => Promise<{ success: boolean; value?: string | null; error?: string; message?: string }>;
    deleteSecret: (account: string) => Promise<{ success: boolean; error?: string; message?: string }>;
    checkStorage: () => Promise<{ success: boolean; message?: string }>;
  };
}