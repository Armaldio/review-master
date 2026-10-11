<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FileDiff, VirtualizedFileDiff, Virtualizer, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import type { AnnotationSide, FileContents, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker';

let workerPool: ReturnType<typeof getOrCreateWorkerPoolSingleton> | undefined;
function getWorkerPool() {
  workerPool ??= getOrCreateWorkerPoolSingleton({
    poolOptions: {
      poolSize: 1,
      workerFactory: () => new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' }),
    },
    highlighterOptions: { theme: { dark: 'pierre-dark', light: 'pierre-light' } },
  });
  return workerPool;
}

const props = defineProps<{ diff: string; path: string; mode: 'split' | 'unified'; wrap: boolean; fullFiles?: { oldContent: string | null; newContent: string | null } }>();
const emit = defineEmits<{
  (event: 'lineSelected', line: { lineNumber: number; side: 'new' | 'old' }): void;
  (event: 'lineRange', range: SelectedLineRange): void;
}>();
const target = ref<HTMLElement | null>(null);
let view: FileDiff<any, any> | VirtualizedFileDiff<any, any> | null = null;
let virtualizer: Virtualizer | null = null;
let parsedDiff: string | undefined;
let parsedPath = '';
let parsedFullFiles: typeof props.fullFiles;
let metadata: ReturnType<typeof parseDiffFromFile> | undefined;
let contentLines = 0;
let previousMode = props.mode;
let previousWrap = props.wrap;
function render() {
  if (!target.value) return;
  const optionsChanged = previousMode !== props.mode || previousWrap !== props.wrap;
  previousMode = props.mode;
  previousWrap = props.wrap;
  const options: FileDiffOptions<any, any> = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' }, diffStyle: props.mode, overflow: props.wrap ? 'wrap' : 'scroll',
    enableLineSelection: true,
    onLineClick: ({ lineNumber, annotationSide }: { lineNumber: number; annotationSide: AnnotationSide }) => emit('lineSelected', { lineNumber, side: annotationSide === 'additions' ? 'new' : 'old' }),
    onLineSelectionEnd: (range: SelectedLineRange | null) => { if (range) emit('lineRange', range); },
  } as FileDiffOptions<any, any>;
  if (parsedDiff !== props.diff || parsedPath !== props.path || parsedFullFiles !== props.fullFiles) {
    parsedDiff = props.diff;
    parsedPath = props.path;
    parsedFullFiles = props.fullFiles;
    metadata = props.fullFiles ? parseDiffFromFile(
      { name: props.path, contents: props.fullFiles.oldContent || '' },
      { name: props.path, contents: props.fullFiles.newContent || '' },
    ) : parsePatchFiles(props.diff)[0]?.files[0];
    contentLines = props.fullFiles
      ? (props.fullFiles.oldContent?.split('\n').length || 0) + (props.fullFiles.newContent?.split('\n').length || 0)
      : props.diff.split('\n').length;
  }
  if (!metadata) return;
  const shouldVirtualize = contentLines > 2_000;
  if (Boolean(virtualizer) !== shouldVirtualize) {
    view?.cleanUp();
    virtualizer?.cleanUp();
    view = null;
    virtualizer = null;
  }
  if (!view && shouldVirtualize) {
    const scrollRoot = target.value.closest('.diff-scroll');
    if (!scrollRoot) return;
    virtualizer = new Virtualizer({ overscrollSize: 250 });
    virtualizer.setup(scrollRoot as HTMLElement);
    view = new VirtualizedFileDiff(options, virtualizer, undefined, getWorkerPool(), true);
  } else if (!view) view = new FileDiff(options, undefined, true);
  else view.setOptions(options);
  const oldFile = props.fullFiles ? { name: props.fullFiles.oldContent === null ? '/dev/null' : props.path, contents: props.fullFiles.oldContent || '' } as FileContents : undefined;
  const newFile = props.fullFiles ? { name: props.fullFiles.newContent === null ? '/dev/null' : props.path, contents: props.fullFiles.newContent || '' } as FileContents : undefined;
  const renderProps = { fileContainer: target.value, fileDiff: metadata, forceRender: optionsChanged };
  if (oldFile && newFile) view.render({ ...renderProps, oldFile, newFile });
  else view.render(renderProps);
}
onMounted(render);
watch(() => [props.diff, props.path, props.mode, props.wrap, props.fullFiles], render);
onBeforeUnmount(() => { view?.cleanUp(); virtualizer?.cleanUp(); });
</script>
<template><div class="diff-shell" :class="{ wrap }" :data-path="path"><diffs-container ref="target" /></div></template>
<style>
diffs-container { display: block; min-width: 100%; font: 12px/1.65 var(--mono); }
.diff-shell { overflow: auto; }
.diff-shell.wrap diffs-container { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
