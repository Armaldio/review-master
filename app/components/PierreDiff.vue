<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { FileDiff, VirtualizedFileDiff, Virtualizer, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import type { AnnotationSide, FileContents, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';

const props = defineProps<{ diff: string; path: string; mode: 'split' | 'unified'; wrap: boolean; fullFiles?: { oldContent: string | null; newContent: string | null } }>();
const emit = defineEmits<{
  (event: 'lineSelected', line: { lineNumber: number; side: 'new' | 'old' }): void;
  (event: 'lineRange', range: SelectedLineRange): void;
}>();
const target = ref<HTMLElement | null>(null);
let view: FileDiff<any> | VirtualizedFileDiff<any> | null = null;
let virtualizer: Virtualizer | null = null;
function render() {
  if (!target.value) return;
  const options: FileDiffOptions<any> = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' }, diffStyle: props.mode, overflow: props.wrap ? 'wrap' : 'scroll',
    enableLineSelection: true,
    onLineClick: ({ lineNumber, annotationSide }: { lineNumber: number; annotationSide: AnnotationSide }) => emit('lineSelected', { lineNumber, side: annotationSide === 'additions' ? 'new' : 'old' }),
    onLineSelectionEnd: (range: SelectedLineRange | null) => { if (range) emit('lineRange', range); },
  } as FileDiffOptions<any>;
  const metadata = props.fullFiles ? parseDiffFromFile(
    { name: props.path, contents: props.fullFiles.oldContent || '' },
    { name: props.path, contents: props.fullFiles.newContent || '' },
  ) : parsePatchFiles(props.diff)[0]?.files[0];
  if (!metadata) return;
  const contentLines = props.fullFiles
    ? (props.fullFiles.oldContent?.split('\n').length || 0) + (props.fullFiles.newContent?.split('\n').length || 0)
    : props.diff.split('\n').length;
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
    view = new VirtualizedFileDiff(options, virtualizer);
  } else if (!view) view = new FileDiff(options);
  else view.setOptions(options);
  const oldFile = props.fullFiles ? { name: props.fullFiles.oldContent === null ? '/dev/null' : props.path, contents: props.fullFiles.oldContent || '' } as FileContents : undefined;
  const newFile = props.fullFiles ? { name: props.fullFiles.newContent === null ? '/dev/null' : props.path, contents: props.fullFiles.newContent || '' } as FileContents : undefined;
  view.render({ fileContainer: target.value, fileDiff: metadata, oldFile, newFile });
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
