<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from "vue";
import { FileDiff } from "@pierre/diffs";
import type {
  FileDiffOptions,
  FileDiffMetadata,
  FileContents,
  DiffLineAnnotation,
} from "@pierre/diffs";

const props = defineProps<{
  options: FileDiffOptions<any>;
  oldFile?: FileContents;
  newFile?: FileContents;
  fileDiff?: FileDiffMetadata;
  lineAnnotations?: DiffLineAnnotation<any>[];
  expandedHunks?: Map<number, any>;
}>();

const emit = defineEmits<{
  (e: 'expandHunk', hunkMap: Map<number, any>): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const wrapperRef = ref<HTMLElement | null>(null);
let fileDiffInstance: FileDiff<any> | null = null;

const renderDiff = () => {
  if (!containerRef.value) return;

  if (!fileDiffInstance) {
    fileDiffInstance = new FileDiff(props.options);
    
    // Intercept hunk expansion to save state
    const originalHandleExpandHunk = (fileDiffInstance as any).handleExpandHunk;
    (fileDiffInstance as any).handleExpandHunk = (...args: any[]) => {
      originalHandleExpandHunk.apply(fileDiffInstance, args);
      // After expansion, the renderer's internal map is updated.
      // We emit the new state so the parent can save it.
      const internalMap = (fileDiffInstance as any).hunksRenderer.expandedHunks;
      emit('expandHunk', internalMap);
    };
  } else {
    fileDiffInstance.setOptions(props.options);
  }

  // Seed the's internal map with our persistent state if provided
  if (props.expandedHunks) {
    const internalMap = (fileDiffInstance as any).hunksRenderer.expandedHunks;
    // We only seed if the map is empty (initial render) or if we want to force it
    // Actually, we should sync it to ensure the view stays correct
    props.expandedHunks.forEach((v, k) => {
      internalMap.set(k, v);
    });
  }

  fileDiffInstance.render({
    fileContainer: containerRef.value,
    oldFile: props.oldFile ? { ...props.oldFile, name: props.oldFile.name || "/dev/null" } : undefined,
    newFile: props.newFile ? { ...props.newFile, name: props.newFile.name || "/dev/null" } : undefined,
    fileDiff: props.fileDiff,
    lineAnnotations: props.lineAnnotations,
  });
};

onMounted(() => {
  renderDiff();
});

watch(
  () => props.options,
  () => {
    // Other options like wordWrap will still trigger an update here.
    // If the viewMode changes, the key in the parent will remount us instead.
    renderDiff();
  },
  { deep: true },
);

watch(
  () => [props.oldFile, props.newFile, props.fileDiff, props.lineAnnotations],
  () => {
    renderDiff();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (fileDiffInstance) {
    fileDiffInstance.cleanUp();
  }
});
</script>

<template>
  <!-- The wrapper is now the capture target to ensure full content is included -->
  <div
    ref="wrapperRef"
    class="diff-viewer-wrapper w-full bg-white dark:bg-gray-950 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800 transition-colors p-6"
    :class="{ 'word-wrap': options.overflow === 'wrap' }"
  >
    <diffs-container
      ref="containerRef"
      class="block w-full min-h-[50px]"
    ></diffs-container>
  </div>
</template>

<style>
diffs-container {
  --pierre-code-font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
    "Courier New", monospace;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre;
}

.diff-viewer-wrapper.word-wrap diffs-container {
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-viewer-wrapper {
  width: 100%;
}
</style>
