<script setup lang="ts">
import { ref, computed } from "vue";

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: Record<string, FileNode>;
  commentCount?: number;
}

const props = defineProps<{
  node: FileNode;
  selectedFile: string | null;
  viewedFiles: Set<string>;
  depth?: number;
}>();

const emit = defineEmits(["select"]);

const isOpen = ref(true);

const toggleOpen = () => {
  if (props.node.isDir) {
    isOpen.value = !isOpen.value;
  } else {
    emit("select", props.node.path);
  }
};

const handleSelect = (path: string) => {
  emit("select", path);
};

const sortedChildren = computed(() => {
  if (!props.node.children) return [];
  return Object.values(props.node.children).sort((a, b) => {
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    return a.name.localeCompare(b.name);
  });
});

const isSelected = computed(() => props.node.path === props.selectedFile);
const isViewed = computed(() => props.viewedFiles.has(props.node.path));
const currentDepth = computed(() => props.depth || 0);
</script>

<template>
  <div class="file-tree-node">
    <div 
      class="node-content"
      :class="{ active: !node.isDir && isSelected, is_dir: node.isDir }"
      :style="{ paddingLeft: `${currentDepth * 16 + 8}px` }"
      @click="toggleOpen"
      v-show="node.name !== 'root'"
    >
      <div v-if="node.isDir" class="icon-folder">
        {{ isOpen ? '▼' : '▶' }}
      </div>
      <div v-else class="icon-file">
        <span class="status-dot" :class="{ viewed: isViewed }"></span>
      </div>
      <span class="node-name">{{ node.name }}</span>
      <div v-if="node.commentCount && node.commentCount > 0" class="comment-badge">
        {{ node.commentCount }}
      </div>
    </div>
    
    <div v-if="node.isDir && isOpen" class="node-children">
      <!-- Recursion: we need to import itself in Vue 3 SFC it does it automatically by filename or by name, but defining a name helps -->
      <FileTreeItem
        v-for="child in sortedChildren"
        :key="child.path"
        :node="child"
        :selectedFile="selectedFile"
        :viewedFiles="viewedFiles"
        :depth="node.name === 'root' ? 0 : currentDepth + 1"
        @select="handleSelect"
      />
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: "FileTreeItem"
};
</script>

<style scoped>
.file-tree-node {
  font-size: 0.9rem;
}
.node-content {
  display: flex;
  align-items: center;
  padding: 0.4rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid #2d2d2d;
  color: #ccc;
  word-break: break-all;
}
.node-content:hover {
  background: #2a2d2e;
}
.node-content.active {
  background: #37373d;
  color: #fff;
}
.icon-folder {
  margin-right: 6px;
  font-size: 0.75rem;
  color: #888;
  width: 14px;
  text-align: center;
}
.icon-file {
  display: flex;
  align-items: center;
  margin-right: 6px;
  width: 14px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ffb000;
  display: inline-block;
  flex-shrink: 0;
}
.status-dot.viewed {
  background: #4caf50;
}
.node-name {
  flex: 1;
}
.comment-badge {
  background: #007acc;
  color: #fff;
  font-size: 0.7rem;
  font-weight: bold;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 14px;
  text-align: center;
  margin-left: 6px;
}
</style>
