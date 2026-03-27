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
}>();

const containerRef = ref<HTMLElement | null>(null);
const wrapperRef = ref<HTMLElement | null>(null);
let fileDiffInstance: FileDiff<any> | null = null;

const renderDiff = () => {
  if (!containerRef.value) return;

  if (!fileDiffInstance) {
    fileDiffInstance = new FileDiff(props.options);
  } else {
    fileDiffInstance.setOptions(props.options);
  }

  fileDiffInstance.render({
    fileContainer: containerRef.value,
    oldFile: props.oldFile,
    newFile: props.newFile,
    fileDiff: props.fileDiff,
    lineAnnotations: props.lineAnnotations,
    forceRender: true,
  });
};

onMounted(() => {
  renderDiff();
});

watch(
  () => props.options,
  () => {
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
}

.diff-viewer-wrapper {
  width: 100%;
}
</style>
