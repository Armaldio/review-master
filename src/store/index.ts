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
  const keyringErrorMessage = ref<string | null>(null);

  const initializeKeyringStatus = async () => {
    const res = await window.electronAPI.checkKeyring();
    isSecureStorageAvailable.value = res.success;
    if (!res.success) {
      keyringErrorMessage.value = res.message || 'Keyring service unavailable';
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

  const clearBatchedComments = () => {
    batchedComments.value = [];
  };

  return {
    activeProvider,
    mrData,
    diffs,
    viewedFiles,
    selectedFile,
    batchedComments,
    isSecureStorageAvailable,
    keyringErrorMessage,
    initializeKeyringStatus,
    currentUser,
    platform,
    remoteComments,
    codeownersRules,
    markFileAsViewed,
    selectFile,
    addBatchedComment,
    removeBatchedComment,
    clearBatchedComments,
    removeRemoteComment
  };
});