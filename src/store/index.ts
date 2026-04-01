import { defineStore } from 'pinia';
import { ref, shallowRef, computed, watch } from 'vue';
import { useStorage } from '@vueuse/core';
import type { BaseProvider } from '../providers/BaseProvider';
import { parseDiffFromFile } from '@pierre/diffs';
import { createProvider, parseUrl, GitLabProvider, GitHubProvider } from '../providers';
import type { DiffFile, MRShortMetadata } from '../providers/types';

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
  
  const liveMRs = ref<MRShortMetadata[]>([]);
  const isLiveLoading = ref(false);

  const fetchRecentActivity = async () => {
    isLiveLoading.value = true;
    try {
      const providers: any[] = [];
      
      // Check GitLab
      const glPat = await window.electronAPI.getSecret('gitlab_pat');
      if (glPat.success && glPat.value) {
        providers.push(new GitLabProvider());
      } else {
        const fallback = localStorage.getItem('gitlab_pat');
        if (fallback) providers.push(new GitLabProvider());
      }

      // Check GitHub
      const ghPat = await window.electronAPI.getSecret('github_pat');
      if (ghPat.success && ghPat.value) {
        providers.push(new GitHubProvider());
      } else {
        const fallback = localStorage.getItem('github_pat');
        if (fallback) providers.push(new GitHubProvider());
      }

      const results = await Promise.all(providers.map(p => p.getActiveMRs()));
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

  const initializeMR = async (url: string) => {
    mrUrl.value = url;
    const provider = createProvider(url);
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
    fetchRecentActivity
  };
});