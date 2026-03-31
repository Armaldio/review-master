import { defineStore } from 'pinia';
import { ref, shallowRef, computed } from 'vue';
import type { BaseProvider } from '../providers/BaseProvider';
import { parseDiffFromFile } from '@pierre/diffs';

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
  const diffs = ref<any[]>([]);
  const viewedFiles = ref<Set<string>>(new Set());
  const selectedFile = ref<string | null>(null);
  const batchedComments = ref<any[]>([]);
  const currentUser = ref<any>(null);
  const platform = ref<'gitlab' | 'github'>('gitlab');
  const remoteComments = ref<any[]>([]);
  const codeownersRules = ref<Array<{ pattern: string, owners: string[] }>>([]);
  const fileOwners = ref<Record<string, string[]>>({});
  const isSecureStorageAvailable = ref<boolean>(true);
  const secureStorageErrorMessage = ref<string | null>(null);

  const initializeStorageStatus = async () => {
    const res = await window.electronAPI.checkStorage();
    isSecureStorageAvailable.value = res.success;
    if (!res.success) {
      secureStorageErrorMessage.value = res.message || 'Secure storage service unavailable';
    }
  };
  
  const markFileAsViewed = (filePath: string) => {
    const next = new Set(viewedFiles.value);
    next.add(filePath);
    viewedFiles.value = next;
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
    updateExpansionState
  };
});