<script setup lang="ts">
import { ref, onMounted, watch, onBeforeUnmount, nextTick } from 'vue';
import { FileDiff, getSingularPatch } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from '@pierre/diffs/worker';
// @ts-ignore
import style_default from '@pierre/diffs/style';

const props = defineProps<{
  diffString: string;
  viewMode: 'split' | 'inline';
}>();

const diffElement = ref<HTMLElement | null>(null);
let fileDiffInstance: FileDiff<any> | null = null;
let workerPool: WorkerPoolManager | null = null;

const initPool = () => {
  if (workerPool) return workerPool;
  try {
    workerPool = getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }),
        poolSize: 4
      },
      highlighterOptions: {
        theme: 'github-dark'
      }
    });
    return workerPool;
  } catch (e) {
    console.error('Failed to initialize worker pool:', e);
    return null;
  }
};

const injectStyles = (container: HTMLElement) => {
  const shadow = container.shadowRoot;
  if (!shadow) return;

  try {
    // Check if styles are already applied
    if (shadow.adoptedStyleSheets.length === 0) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(style_default);
      shadow.adoptedStyleSheets = [sheet];
    }
  } catch (e) {
    // Fallback for environments where adoptedStyleSheets might fail
    const styleTag = document.createElement('style');
    styleTag.textContent = style_default;
    shadow.appendChild(styleTag);
  }
};

const renderDiff = async () => {
  await nextTick();
  if (!diffElement.value) return;

  const pool = initPool();
  
  let fileDiffData;
  try {
    fileDiffData = getSingularPatch(props.diffString);
  } catch (e) {
    console.error('Failed to parse patch:', e);
    return;
  }

  const options = {
    theme: 'github-dark',
    diffStyle: props.viewMode === 'split' ? 'split' : 'unified' as any,
    enableLineSelection: true,
  };

  if (!fileDiffInstance) {
    fileDiffInstance = new FileDiff(options, pool || undefined);
  } else {
    fileDiffInstance.setOptions(options);
  }

  // FileDiff.render will call attachShadow on the container
  const success = fileDiffInstance.render({
    fileDiff: fileDiffData,
    fileContainer: diffElement.value,
  });

  if (success) {
    injectStyles(diffElement.value);
  } else {
    console.warn('FileDiff.render returned false.');
  }
};

onMounted(() => {
  renderDiff();
});

watch(() => props.diffString, () => {
  if (fileDiffInstance) {
    fileDiffInstance.cleanUp();
    fileDiffInstance = null;
  }
  renderDiff();
});

watch(() => props.viewMode, () => {
  renderDiff();
});

onBeforeUnmount(() => {
  if (fileDiffInstance) {
    fileDiffInstance.cleanUp();
  }
});
</script>

<template>
  <div class="diff-wrapper">
    <div ref="diffElement" class="pierre-diff"></div>
  </div>
</template>

<style scoped>
.diff-wrapper {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pierre-diff {
  flex: 1;
  min-height: 500px;
  background: #1e1e1e;
  display: block;
}
</style>