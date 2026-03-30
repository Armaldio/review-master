import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import type { BaseProvider } from '../providers/BaseProvider';

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
    viewedFiles.value.add(filePath);
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
      if (res.success) {
        console.log(`[Store] Semantic diff result for ${file.new_path}:`, res.data);
        semanticDiffs.value[file.new_path] = res.data;
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
      if (res.success) {
        console.log(`[Store] AST diff result for ${file.new_path}:`, res.data);
        astDiffs.value[file.new_path] = res.data;
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
    isSecureStorageAvailable,
    secureStorageErrorMessage,
    initializeStorageStatus,
    markFileAsViewed,
    selectFile,
    addBatchedComment,
    removeBatchedComment,
    clearBatchedComments,
    removeRemoteComment
  };
});