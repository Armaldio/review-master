import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useReviewStore = defineStore('review', () => {
  const mrData = ref<any>(null);
  const diffs = ref<any[]>([]);
  const viewedFiles = ref<Set<string>>(new Set());
  const selectedFile = ref<string | null>(null);
  const batchedComments = ref<any[]>([]);
  const currentUser = ref<any>(null);
  const codeownersRules = ref<Array<{ pattern: string, owners: string[] }>>([]);
  
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

  const clearBatchedComments = () => {
    batchedComments.value = [];
  };

  return {
    mrData,
    diffs,
    viewedFiles,
    selectedFile,
    batchedComments,
    currentUser,
    codeownersRules,
    markFileAsViewed,
    selectFile,
    addBatchedComment,
    removeBatchedComment,
    clearBatchedComments
  };
});