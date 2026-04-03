/// <reference types="vite/client" />

declare interface Window {
  electronAPI: {
    cloneRepo: (repoUrl: string, targetPath: string) => Promise<{ success: boolean; error?: string }>;
    getAppPath: () => Promise<string>;
    readFile: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;
    setSecret: (account: string, value: string) => Promise<{ success: boolean; error?: string; message?: string }>;
    getSecret: (account: string) => Promise<{ success: boolean; value?: string; error?: string }>;
    deleteSecret: (account: string) => Promise<{ success: boolean; error?: string }>;
    checkStorage: () => Promise<{ success: boolean; message: string }>;
    runSem: (payload: any) => Promise<{ success: boolean; data?: any; error?: string; raw?: string; input?: string }>;
    runDifftastic: (payload: any) => Promise<{ success: boolean; data?: any; error?: string; raw?: string }>;
    runInspect: (payload: { platform: string; prNumber: number; ownerRepo: string; token?: string }) => Promise<{ success: boolean; data?: any; error?: string; raw?: string }>;
    checkBinaries: () => Promise<{ sem: boolean; difft: boolean; inspect: boolean }>;
    openExternal: (url: string) => Promise<void>;
    parseCodeowners: (content: string) => Promise<Array<{ pattern: string; owners: string[] }>>;
    matchCodeowners: (filePath: string, rules: any[]) => Promise<{ pattern: string; owners: string[] } | null>;
    matchCodeownersBulk: (filePaths: string[], rules: any[]) => Promise<Record<string, string[]>>;
  };
}