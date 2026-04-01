import { defineStore } from 'pinia';
import { ref, shallowRef, computed, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import type { BaseProvider } from '../providers/BaseProvider';
import { parseDiffFromFile } from '@pierre/diffs';
import { createProvider, parseUrl, GitLabProvider, GitHubProvider } from '../providers';
import type { DiffFile, MRShortMetadata, Account } from '../providers/types';

export const getLanguage = (filePath: string) => {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return 'text';
  const map: Record<string, string> = {
    'vue': 'vue',
    'ts': 'typescript',
    'tsx': 'typescript',
    'js': 'javascript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    'jsx': 'javascript',
    'css': 'css',
    'html': 'html',
    'json': 'json',
    'md': 'markdown',
    'py': 'python',
    'go': 'go',
    'rs': 'rust'
  };
  return map[ext] || ext;
};

export const useReviewStore = defineStore('review', () => {
  const activeProvider = shallowRef<BaseProvider | null>(null);
  const mrData = ref<any>(null);
  const mrUrl = ref<string>('');
  const diffs = ref<DiffFile[]>([]);
  // Use persistent storage for viewed files, keyed by MR ID
  const viewedFiles = ref<Record<string, string>>({});
  
  // Watch for mrData.id changes to load/save viewed files
  watch(() => mrData.value?.id, (newId) => {
    if (newId) {
      const storage = useStorage<Record<string, string>>(`viewed_files_${newId}`, {});
      viewedFiles.value = storage.value;
      // Sync back to storage when changed
      watch(viewedFiles, (v) => { storage.value = v; }, { deep: true });
    } else {
      viewedFiles.value = {};
    }
  }, { immediate: true });

  const selectedFile = ref<string | null>(null);
  const batchedComments = ref<any[]>([]);
  const currentUser = ref<any>(null);
  const platform = ref<'gitlab' | 'github'>('gitlab');
  const remoteComments = ref<any[]>([]);
  const codeownersRules = ref<Array<{ pattern: string, owners: string[] }>>([]);
  const fileOwners = ref<Record<string, string[]>>({});
  const isSecureStorageAvailable = ref<boolean>(true);
  const secureStorageErrorMessage = ref<string | null>(null);
  
  const accounts = useStorage<Account[]>('accounts', []);
  const liveMRs = ref<MRShortMetadata[]>([]);
  const isLiveLoading = ref(false);

  const migrateLegacyAccounts = async () => {
    // Check if we already have accounts or if we need to migrate
    if (accounts.value.length > 0) return;

    console.log('[Store] Checking for legacy tokens to migrate...');
    const migrated: Account[] = [];

    // GitLab Migration
    const glRes = await window.electronAPI.getSecret('gitlab_pat');
    const glToken = glRes.success && glRes.value ? glRes.value : localStorage.getItem('gitlab_pat');
    
    if (glToken) {
      console.log('[Store] Migrating legacy GitLab token...');
      try {
        const provider = new GitLabProvider();
        // Temporarily set tokenKey for fetch
        (provider as any).tokenKey = 'gitlab_pat';
        const userRes = await fetch('https://gitlab.com/api/v4/user', {
          headers: { 'PRIVATE-TOKEN': glToken }
        });
        if (userRes.ok) {
          const user = await userRes.json();
          migrated.push({
            id: 'legacy-gitlab',
            platform: 'gitlab',
            host: 'https://gitlab.com',
            tokenKey: 'gitlab_pat',
            username: user.username,
            avatar_url: user.avatar_url,
            name: user.name
          });
        }
      } catch (e) {
        console.error('[Store] Failed to migrate GitLab token:', e);
      }
    }

    // GitHub Migration
    const ghRes = await window.electronAPI.getSecret('github_pat');
    const ghToken = ghRes.success && ghRes.value ? ghRes.value : localStorage.getItem('github_pat');
    
    if (ghToken) {
      console.log('[Store] Migrating legacy GitHub token...');
      try {
        const userRes = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${ghToken}` }
        });
        if (userRes.ok) {
          const user = await userRes.json();
          migrated.push({
            id: 'legacy-github',
            platform: 'github',
            host: 'https://github.com',
            tokenKey: 'github_pat',
            username: user.login,
            avatar_url: user.avatar_url,
            name: user.name
          });
        }
      } catch (e) {
        console.error('[Store] Failed to migrate GitHub token:', e);
      }
    }

    if (migrated.length > 0) {
      accounts.value = migrated;
      console.log(`[Store] Successfully migrated ${migrated.length} accounts.`);
    }
  };

  const fetchRecentActivity = async () => {
    if (accounts.value.length === 0) {
      await migrateLegacyAccounts();
    }
    
    if (accounts.value.length === 0) return;

    isLiveLoading.value = true;
    try {
      const providers = accounts.value.map(acc => {
        if (acc.platform === 'github') return new GitHubProvider(acc);
        return new GitLabProvider(acc);
      });

      const results = await Promise.all(providers.map(p => p.getActiveMRs().catch(err => {
        console.error(`[Store] Failed to fetch activity for ${p.platform}:`, err);
        return [];
      })));
      
      const flatResults = results.flat() as MRShortMetadata[];
      
      // Sort by updated_at desc
      liveMRs.value = flatResults.sort((a, b) => 
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );
    } catch (e) {
      console.error('[Store] Failed to fetch recent activity:', e);
    } finally {
      isLiveLoading.value = false;
    }
  };

  const initializeStorageStatus = async () => {
    const res = await window.electronAPI.checkStorage();
    isSecureStorageAvailable.value = res.success;
    if (!res.success) {
      secureStorageErrorMessage.value = res.message || 'Secure storage service unavailable';
    }
  };
  
  const markFileAsViewed = (filePath: string) => {
    if (!mrData.value) return;
    const file = diffs.value.find(d => d.new_path === filePath);
    if (!file) return;
    viewedFiles.value[filePath] = file.sha;
  };
  
  const selectFile = (filePath: string) => {
    selectedFile.value = filePath;
  };
  
  const addBatchedComment = (comment: any) => {
    batchedComments.value.push(comment);
  };
  
  const removeBatchedComment = (id: string) => {
    batchedComments.value = batchedComments.value.filter(c => c.id !== id);
  };

  const removeRemoteComment = (id: string) => {
    remoteComments.value = remoteComments.value.filter(c => c.id !== id);
  };

  const semanticDiffs = ref<Record<string, any>>({});
  const astDiffs = ref<Record<string, any>>({});
  const fileContents = ref<Record<string, { old: string; new: string }>>({});
  const isSemanticLoading = ref(false);
  const isAstLoading = ref(false);
  const fileExpansionStates = ref<Record<string, Map<number, any>>>({});

  const updateExpansionState = (filePath: string, hunkMap: Map<number, any>) => {
    fileExpansionStates.value[filePath] = new Map(hunkMap);
  };

  const fetchFileContents = async (file: any) => {
    if (!activeProvider.value || !mrData.value || !file) return;
    
    // Check cache
    if (fileContents.value[file.new_path]) return fileContents.value[file.new_path];

    try {
      const [beforeContent, afterContent] = await Promise.all([
        activeProvider.value.getFileContent(file.old_path, mrData.value.baseSha),
        activeProvider.value.getFileContent(file.new_path, mrData.value.headSha)
      ]);

      fileContents.value[file.new_path] = {
        old: beforeContent,
        new: afterContent
      };
      
      return fileContents.value[file.new_path];
    } catch (e) {
      console.error('[Store] Failed to fetch file contents:', e);
      return null;
    }
  };

  const fetchSemanticDiff = async (file: any) => {
    if (!activeProvider.value || !mrData.value || !file) return;
    
    isSemanticLoading.value = true;
    try {
      // Use shared cache
      const contents = await fetchFileContents(file);
      if (!contents) throw new Error('Could not retrieve file contents');

      const payload = {
        filePath: file.new_path,
        status: file.new_file ? 'added' : file.deleted_file ? 'deleted' : 'modified',
        beforeContent: contents.old,
        afterContent: contents.new
      };

      const res = await window.electronAPI.runSem(payload);
      if (res.success && res.data) {
        const result = Array.isArray(res.data) ? res.data[0] : res.data;
        if (!result) throw new Error('Empty semantic diff result');

        if (result.entities) {
          for (const entity of result.entities) {
            try {
              // Normalize language for highlighter
              const lang = (result.language || getLanguage(file.new_path)).toLowerCase();
              entity.diffMetadata = parseDiffFromFile(
                { name: entity.filePath || file.new_path, contents: entity.beforeContent || "", lang },
                { name: entity.filePath || file.new_path, contents: entity.afterContent || "", lang }
              );
            } catch (e) {
              console.warn('[Store] Failed to generate semantic metadata for entity:', entity.entityName, e);
            }
          }
        }
        console.log(`[Store] Semantic diff result for ${file.new_path}:`, result);
        semanticDiffs.value[file.new_path] = result;
      } else {
        console.error('[Store] Semantic diff failed:', res.error);
      }
    } catch (e) {
      console.error('[Store] Semantic diff failed:', e);
    } finally {
      isSemanticLoading.value = false;
    }
  };

  const fetchAstDiff = async (file: any) => {
    if (!activeProvider.value || !mrData.value || !file) return;
    
    isAstLoading.value = true;
    try {
      const contents = await fetchFileContents(file);
      if (!contents) throw new Error('Could not retrieve file contents');

      const payload = {
        filePath: file.new_path,
        beforeContent: contents.old,
        afterContent: contents.new
      };

      const res = await window.electronAPI.runDifftastic(payload);
      if (res.success && res.data) {
        const result = Array.isArray(res.data) ? res.data[0] : res.data;
        if (!result) throw new Error('Empty AST diff result');

        if (result.chunks) {
          const lang = (result.language || getLanguage(file.new_path)).toLowerCase();
          for (const chunk of result.chunks) {
            // Reconstruct LHS and RHS for the chunk to generate metadata
            // Group changes by line number if necessary, but here we assume each item is a line
            const lhsContent = chunk
              .map((item: any) => {
                const data = item.lhs;
                if (!data || !data.changes) return null;
                return data.changes.map((c: any) => c.content).join('');
              })
              .filter((c: any) => c !== null)
              .join('\n');

            const rhsContent = chunk
              .map((item: any) => {
                const data = item.rhs;
                if (!data || !data.changes) return null;
                return data.changes.map((c: any) => c.content).join('');
              })
              .filter((c: any) => c !== null)
              .join('\n');

            try {
              chunk.diffMetadata = parseDiffFromFile(
                { name: file.old_path, contents: lhsContent, lang },
                { name: file.new_path, contents: rhsContent, lang }
              );
              chunk.reconstructedLhs = lhsContent;
              chunk.reconstructedRhs = rhsContent;
            } catch (e) {
              console.warn('[Store] Failed to generate AST metadata for chunk', e);
            }
          }
        }
        console.log(`[Store] AST diff result for ${file.new_path}:`, result);
        astDiffs.value[file.new_path] = result;
      } else {
        console.error('[Store] AST diff failed:', res.error);
      }
    } catch (e) {
      console.error('[Store] AST diff failed:', e);
    } finally {
      isAstLoading.value = false;
    }
  };

  const clearBatchedComments = () => {
    batchedComments.value = [];
  };

  const addAccount = async (platform: 'github' | 'gitlab', host: string, token: string) => {
    let username = '';
    let avatar_url = '';
    let name = '';

    // Verify token and get User Info
    try {
      if (platform === 'gitlab') {
        const res = await fetch(`${host}/api/v4/user`, {
          headers: { 'PRIVATE-TOKEN': token }
        });
        if (!res.ok) throw new Error('Invalid GitLab token or host');
        const user = await res.json();
        username = user.username;
        avatar_url = user.avatar_url;
        name = user.name;
      } else {
        const res = await fetch('https://api.github.com/user', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!res.ok) throw new Error('Invalid GitHub token');
        const user = await res.json();
        username = user.login;
        avatar_url = user.avatar_url;
        name = user.name;
      }
    } catch (e: any) {
      throw new Error(`Verification failed: ${e.message}`);
    }

    const id = crypto.randomUUID();
    const tokenKey = `token_${id}`;

    // Save token securely
    await window.electronAPI.setSecret(tokenKey, token);

    const newAccount: Account = {
      id,
      platform,
      host,
      tokenKey,
      username,
      avatar_url,
      name,
      lastTestedAt: new Date().toISOString()
    };

    accounts.value.push(newAccount);
    return newAccount;
  };

  const removeAccount = async (id: string) => {
    const account = accounts.value.find(a => a.id === id);
    if (account) {
      await window.electronAPI.deleteSecret(account.tokenKey);
      accounts.value = accounts.value.filter(a => a.id !== id);
    }
  };

  const initializeMR = async (url: string) => {
    mrUrl.value = url;
    const provider = createProvider(url, accounts.value);
    const parsed = parseUrl(url);
    
    await provider.initialize(parsed);
    
    // Sync store with provider data
    activeProvider.value = provider;
    mrData.value = provider.mrData;
    diffs.value = provider.diffs;
    currentUser.value = provider.currentUser;
    platform.value = provider.platform;
    remoteComments.value = provider.remoteComments;
    codeownersRules.value = provider.codeownersRules;

    // Re-review logic: check if viewed files have changed SHAs
    if (mrData.value?.id) {
        // viewedFiles is already loaded via watch
        const newViewed: Record<string, string> = {};
        for (const [path, oldSha] of Object.entries(viewedFiles.value)) {
            const currentFile = diffs.value.find(d => d.new_path === path);
            if (currentFile && currentFile.sha === oldSha) {
                newViewed[path] = oldSha;
            }
            // else: file is missing or SHA changed -> implicit un-view
        }
        viewedFiles.value = newViewed;
    }

    // Cache file ownership for all changed files
    if (codeownersRules.value.length > 0) {
      const filePaths = diffs.value.map(f => f.new_path);
      fileOwners.value = await window.electronAPI.matchCodeownersBulk(filePaths, codeownersRules.value);
    } else {
      fileOwners.value = {};
    }

    if (diffs.value.length > 0 && !selectedFile.value) {
      selectFile(diffs.value[0].new_path);
    }
  };

  return {
    activeProvider,
    mrData,
    diffs,
    viewedFiles,
    selectedFile,
    semanticDiffs,
    astDiffs,
    fileContents,
    isSemanticLoading,
    isAstLoading,
    fetchFileContents,
    fetchSemanticDiff,
    fetchAstDiff,
    batchedComments,
    currentUser,
    platform,
    remoteComments,
    codeownersRules,
    fileOwners,
    isSecureStorageAvailable,
    secureStorageErrorMessage,
    initializeStorageStatus,
    markFileAsViewed,
    selectFile,
    addBatchedComment,
    removeBatchedComment,
    clearBatchedComments,
    removeRemoteComment,
    fileExpansionStates,
    updateExpansionState,
    mrUrl,
    initializeMR,
    liveMRs,
    isLiveLoading,
    fetchRecentActivity,
    accounts,
    addAccount,
    removeAccount
  };
});