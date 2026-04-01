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
  
  // Watch for mrData.id changes to load viewed files
  watch(() => mrData.value?.id, (newId) => {
    if (!newId) {
      viewedFiles.value = {};
    }
  }, { immediate: true });

  // Sync viewedFiles to storage whenever it changes
  watch(viewedFiles, (v) => {
    if (mrData.value?.id) {
        localStorage.setItem(`viewed_files_${mrData.value.id}`, JSON.stringify(v));
    }
  }, { deep: true });

  const selectedFile = ref<string | null>(null);
  const batchedComments = ref<any[]>([]);
  const currentUser = ref<any>(null);
  const platform = ref<'gitlab' | 'github'>('gitlab');
  const remoteComments = ref<any[]>([]);
  const codeownersRules = ref<Array<{ pattern: string, owners: string[] }>>([]);
  const fileOwners = ref<Record<string, string[]>>({});
  
  const accounts = useStorage<Account[]>('accounts', [], localStorage);
  const liveMRs = ref<MRShortMetadata[]>([]);
  const isLiveLoading = ref(false);
  
  // Polling State
  const isPolling = ref(false);
  const pollInterval = ref(10000); // Base 10s
  const pollTimer = ref<any>(null);
  const sidebarFlash = ref(false);
  const lastPolledAt = ref<string | null>(null);

  // --- Computed Analytics ---

  /**
   * Flat list of all unique threads (discussions) across all files.
   * Groups comments by location if they belong to the same thread ID (if provider supports it),
   * otherwise treats each remote comment as a potential discussion point.
   */
  const allDiscussions = computed(() => {
    // For now, we'll treat each remote comment as a discussion point.
    // In many providers, 'remoteComments' are already thread-parent or we have a flat list.
    return [...remoteComments.value].sort((a, b) => 
      new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    );
  });

  /**
   * Map of file paths to comment statistics (unresolved, total).
   */
  const commentStatsByFile = computed(() => {
    const stats: Record<string, { unresolved: number; total: number }> = {};
    
    remoteComments.value.forEach(comment => {
      const path = comment.new_path;
      if (!path) return;
      
      if (!stats[path]) {
        stats[path] = { unresolved: 0, total: 0 };
      }
      
      stats[path].total++;
      if (!comment.resolved) {
        stats[path].unresolved++;
      }
    });
    
    return stats;
  });

  const migrateLegacyAccounts = async () => {
    // Check if we already have accounts or if we need to migrate
    if (accounts.value.length > 0) {
      console.log('[Store] Migration skipped: accounts already present.');
      return;
    }

    console.log('[Store] Checking for legacy tokens to migrate...');
    const migrated: Account[] = [];

    // GitLab Migration
    const glToken = localStorage.getItem('gitlab_pat');
    
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
    const ghToken = localStorage.getItem('github_pat');
    
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

  const markFileAsViewed = (filePath: string) => {
    if (!mrData.value) return;
    const file = diffs.value.find(d => d.new_path === filePath);
    if (!file) return;
    // Use object spread to ensure reactivity
    viewedFiles.value = { ...viewedFiles.value, [filePath]: file.sha };
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

    // Save token to localStorage
    localStorage.setItem(tokenKey, token);

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

    // Update accounts list using spread to ensure reactivity/persistence
    accounts.value = [...accounts.value, newAccount];
    console.log('[Store] Account added and persisted:', newAccount.username);
    return newAccount;
  };

  const removeAccount = async (id: string) => {
    const account = accounts.value.find(a => a.id === id);
    if (account) {
      localStorage.removeItem(account.tokenKey);
      accounts.value = accounts.value.filter(a => a.id !== id);
      console.log('[Store] Account removed.');
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
        // Load from storage SYNCHRONOUSLY to avoid race conditions
        const savedViewed = localStorage.getItem(`viewed_files_${mrData.value.id}`);
        let loaded: Record<string, string> = {};
        try {
            loaded = savedViewed ? JSON.parse(savedViewed) : {};
        } catch (e) {
            loaded = {};
        }

        const newViewed: Record<string, string> = {};
        for (const [path, oldSha] of Object.entries(loaded)) {
            const currentFile = diffs.value.find(d => d.new_path === path);
            if (currentFile && currentFile.sha === oldSha) {
                newViewed[path] = oldSha;
            }
        }
        viewedFiles.value = newViewed;
    }

    // Cache file ownership for all changed files
    if (codeownersRules.value.length > 0) {
      const filePaths = diffs.value.map(f => f.new_path);
      // We MUST sanitize the reactive rules to plain objects before passing to IPC bridge
      // Electron's structured clone algorithm doesn't like Proxies
      const sanitizedRules = JSON.parse(JSON.stringify(codeownersRules.value));
      fileOwners.value = await window.electronAPI.matchCodeownersBulk(filePaths, sanitizedRules);
    } else {
      fileOwners.value = {};
    }

    if (diffs.value.length > 0 && !selectedFile.value) {
      selectFile(diffs.value[0].new_path);
    }
  };

  const stopPolling = () => {
    isPolling.value = false;
    if (pollTimer.value) {
      clearTimeout(pollTimer.value);
      pollTimer.value = null;
    }
  };

  const startPolling = () => {
    if (isPolling.value) return;
    isPolling.value = true;
    pollInterval.value = 10000;
    pollComments();
  };

  const pollComments = async () => {
    if (!activeProvider.value || !mrData.value || !isPolling.value) return;

    try {
      const [newMetadata, newComments] = await Promise.all([
        activeProvider.value.getMRMetadata(),
        activeProvider.value.getComments()
      ]);

      let hasChanged = false;

      // 1. Check Metadata (v2.14.0+: check updated_at or headSha)
      if (newMetadata.updated_at !== mrData.value.updated_at || newMetadata.headSha !== mrData.value.headSha) {
        hasChanged = true;
      }

      // 2. Check Comments (Simple count check + signature check if count is same)
      if (newComments.length !== remoteComments.value.length) {
        hasChanged = true;
      } else {
        // Quick signature check
        const oldSig = remoteComments.value.map(c => `${c.id}:${c.resolved}:${c.body.length}`).join('|');
        const newSig = newComments.map(c => `${c.id}:${c.resolved}:${c.body.length}`).join('|');
        if (oldSig !== newSig) hasChanged = true;
      }

      if (hasChanged) {
        console.log('[Store] Changes detected during polling. Syncing state...');
        
        // Update store
        mrData.value = { ...mrData.value, ...newMetadata };
        remoteComments.value = newComments;
        
        // Trigger Flash
        sidebarFlash.value = true;
        setTimeout(() => { sidebarFlash.value = false; }, 2000);
        
        // Reset interval
        pollInterval.value = 10000;
      } else {
        // Increment interval if no changes (max 2 minutes)
        pollInterval.value = Math.min(pollInterval.value + 10000, 120000);
      }

      lastPolledAt.value = new Date().toLocaleTimeString();
    } catch (e) {
      console.error('[Store] Polling failed:', e);
    } finally {
      if (isPolling.value) {
        pollTimer.value = setTimeout(pollComments, pollInterval.value);
      }
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
    removeAccount,
    isPolling,
    pollInterval,
    sidebarFlash,
    lastPolledAt,
    startPolling,
    stopPolling,
    allDiscussions,
    commentStatsByFile
  };
});