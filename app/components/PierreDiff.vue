<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { CodeView, FileDiff, VirtualizedFileDiff, Virtualizer, parseDiffFromFile, parsePatchFiles } from '@pierre/diffs';
import type { AnnotationSide, CodeViewOptions, FileContents, FileDiffOptions, SelectedLineRange } from '@pierre/diffs';
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

const props = defineProps<{ diff: string; path: string; oldPath?: string; newFile?: boolean; deletedFile?: boolean; mode: 'split' | 'unified'; wrap: boolean; continuous?: boolean; fullFiles?: { oldContent: string | null; newContent: string | null } }>();
const emit = defineEmits<{
  (event: 'ready'): void;
  (event: 'lineSelected', line: { lineNumber: number; side: 'new' | 'old' }): void;
  (event: 'lineRange', range: SelectedLineRange): void;
}>();
const target = ref<HTMLElement | null>(null);
let view: FileDiff<any, any> | VirtualizedFileDiff<any, any> | CodeView<any, any> | null = null;
let virtualizer: Virtualizer | null = null;
let fileContainer: HTMLElement | null = null;
let viewKind: 'simple' | 'code' | null = null;
let codeViewItemVersion = 0;
let parsedDiff: string | undefined;
let parsedPath = '';
let parsedFullFiles: typeof props.fullFiles;
let metadata: ReturnType<typeof parseDiffFromFile> | undefined;
let contentLines = 0;
let previousMode = props.mode;
let previousWrap = props.wrap;
let readyObserver: MutationObserver | null = null;
let readyEmitted = false;
function notifyReady() {
  if (readyEmitted || !target.value) return;
  const root = target.value.querySelector('diffs-container')?.shadowRoot;
  if (root && !readyObserver) {
    readyObserver = new MutationObserver(notifyReady);
    readyObserver.observe(root, { childList: true, subtree: true });
  }
  if (target.value.querySelector('.raw-diff') || root?.querySelector('[data-line]')) {
    readyEmitted = true;
    readyObserver?.disconnect();
    emit('ready');
  }
}
function render() {
  if (!target.value) return;
  let metadataChanged = false;
  const optionsChanged = previousMode !== props.mode || previousWrap !== props.wrap;
  previousMode = props.mode;
  previousWrap = props.wrap;
  const options: FileDiffOptions<any, any> = {
    theme: { dark: 'pierre-dark', light: 'pierre-light' }, diffStyle: props.mode, overflow: props.wrap ? 'wrap' : 'scroll', stickyHeader: true,
    enableLineSelection: true,
    onLineClick: ({ lineNumber, annotationSide }: { lineNumber: number; annotationSide: AnnotationSide }) => emit('lineSelected', { lineNumber, side: annotationSide === 'additions' ? 'new' : 'old' }),
    onLineSelectionEnd: (range: SelectedLineRange | null) => { if (range) emit('lineRange', range); },
  } as Omit<FileDiffOptions<any, any>, 'hunkSeparators'>;
  if (parsedDiff !== props.diff || parsedPath !== props.path || parsedFullFiles !== props.fullFiles) {
    metadataChanged = true;
    parsedDiff = props.diff;
    parsedPath = props.path;
    parsedFullFiles = props.fullFiles;
    const oldPath = props.oldPath || props.path;
    const patchHeader = [
      `diff --git a/${oldPath} b/${props.path}`,
      ...(props.newFile ? ['new file mode 100644'] : []),
      ...(props.deletedFile ? ['deleted file mode 100644'] : []),
      `--- ${props.newFile ? '/dev/null' : `a/${oldPath}`}`,
      `+++ ${props.deletedFile ? '/dev/null' : `b/${props.path}`}`,
      '',
    ].join('\n');
    metadata = props.fullFiles ? parseDiffFromFile(
      { name: props.path, contents: props.fullFiles.oldContent || '' },
      { name: props.path, contents: props.fullFiles.newContent || '' },
    ) : parsePatchFiles(patchHeader + props.diff)[0]?.files[0];
    contentLines = props.fullFiles
      ? (props.fullFiles.oldContent?.split('\n').length || 0) + (props.fullFiles.newContent?.split('\n').length || 0)
      : props.diff.split('\n').length;
  }
  // Tokenizing every line of a pathological diff adds work after its rows are usable.
  // Pierre keeps the diff interactive and renders plain text beyond this limit.
  options.tokenizeMaxLength = contentLines > 10_000 ? 10_000 : undefined;
  if (!metadata) {
    view?.cleanUp();
    virtualizer?.cleanUp();
    view = null;
    virtualizer = null;
    fileContainer = null;
    viewKind = null;
    target.value.replaceChildren();
    const fallback = document.createElement('pre');
    fallback.className = 'raw-diff';
    fallback.textContent = props.diff || 'Pierre could not parse this GitLab diff.';
    target.value.appendChild(fallback);
    target.value.classList.remove('code-view');
    notifyReady();
    return;
  }
  const shouldVirtualize = contentLines > 2_000;
  const nextViewKind = shouldVirtualize && !props.continuous ? 'code' : 'simple';
  const codeViewOptions = { ...options, stickyHeaders: true } as CodeViewOptions<any, any>;
  target.value.classList.toggle('code-view', nextViewKind === 'code');
  if (viewKind !== nextViewKind) {
    view?.cleanUp();
    virtualizer?.cleanUp();
    target.value.replaceChildren();
    view = null;
    virtualizer = null;
    fileContainer = null;
    viewKind = nextViewKind;
  }
  if (viewKind === 'code') {
    if (!view) {
      const codeView = new CodeView(codeViewOptions, getWorkerPool(), true);
      codeView.setup(target.value);
      codeView.setItems([{ id: props.path, type: 'diff', fileDiff: metadata, version: ++codeViewItemVersion }]);
      view = codeView;
    } else {
      const codeView = view as CodeView<any, any>;
      if (metadataChanged) codeView.setItems([{ id: props.path, type: 'diff', fileDiff: metadata, version: ++codeViewItemVersion }]);
      if (optionsChanged) codeView.setOptions(codeViewOptions);
    }
    notifyReady();
    return;
  }
  if (!view && shouldVirtualize) {
    const scrollRoot = target.value.closest('.diff-scroll');
    if (!scrollRoot) return;
    virtualizer = new Virtualizer({ overscrollSize: 250 });
    virtualizer.setup(scrollRoot as HTMLElement);
    view = new VirtualizedFileDiff(options, virtualizer, undefined, getWorkerPool(), true);
  } else if (!view) {
    fileContainer = document.createElement('diffs-container');
    target.value.appendChild(fileContainer);
    view = new FileDiff(options, undefined, true);
  } else (view as FileDiff<any, any> | VirtualizedFileDiff<any, any>).setOptions(options as FileDiffOptions<any, any>);
  const oldFile = props.fullFiles ? { name: props.fullFiles.oldContent === null ? '/dev/null' : props.path, contents: props.fullFiles.oldContent || '' } as FileContents : undefined;
  const newFile = props.fullFiles ? { name: props.fullFiles.newContent === null ? '/dev/null' : props.path, contents: props.fullFiles.newContent || '' } as FileContents : undefined;
  const simpleView = view as FileDiff<any, any> | VirtualizedFileDiff<any, any>;
  const renderProps = { fileContainer: fileContainer!, fileDiff: metadata, forceRender: optionsChanged };
  if (oldFile && newFile) simpleView.render({ ...renderProps, oldFile, newFile });
  else simpleView.render(renderProps);
  notifyReady();
}
onMounted(render);
watch(() => [props.diff, props.path, props.mode, props.wrap, props.continuous, props.fullFiles], render);
onBeforeUnmount(() => { readyObserver?.disconnect(); view?.cleanUp(); virtualizer?.cleanUp(); });
</script>
<template><div ref="target" class="diff-shell" :class="{ wrap }" :data-path="path" /></template>
<style>
diffs-container { display: block; min-width: 100%; font: 12px/1.65 var(--mono); }
.diff-shell { overflow: auto; }
.diff-shell.code-view { width: 100%; height: 100%; min-height: 0; }
.diff-shell.wrap diffs-container { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
