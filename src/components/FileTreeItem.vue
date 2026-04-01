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
  viewedFiles: Record<string, string>;
  depth?: number;
  sortViewedToBottom?: boolean;
  commentStats?: Record<string, { unresolved: number; total: number }>;
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
  const children = Object.values(props.node.children);
  
  return children.sort((a, b) => {
    // Basic sorting: directories first
    if (a.isDir && !b.isDir) return -1;
    if (!a.isDir && b.isDir) return 1;
    
    // Optional sorting: viewed to bottom
    if (props.sortViewedToBottom) {
      const aViewed = isNodeViewed(a);
      const bViewed = isNodeViewed(b);
      if (aViewed !== bViewed) return aViewed ? 1 : -1;
    }
    
    return a.name.localeCompare(b.name);
  });
});

const isNodeViewed = (node: FileNode): boolean => {
    if (!node.isDir) return !!props.viewedFiles[node.path];
    if (!node.children || Object.keys(node.children).length === 0) return true;
    return Object.values(node.children).every(child => isNodeViewed(child));
};

const isSelected = computed(() => props.node.path === props.selectedFile);
const isViewed = computed(() => isNodeViewed(props.node));
const currentDepth = computed(() => props.depth || 0);

const nodeCommentStats = computed(() => {
  if (!props.commentStats) return null;
  // If it's a file, return its stats
  if (!props.node.isDir) {
    return props.commentStats[props.node.path] || null;
  }
  
  // If it's a directory, aggregate stats from all descendants
  let unresolved = 0;
  let total = 0;
  
  const aggregate = (n: FileNode) => {
    if (!n.isDir) {
      const s = props.commentStats![n.path];
      if (s) {
        unresolved += s.unresolved;
        total += s.total;
      }
    } else if (n.children) {
      Object.values(n.children).forEach(aggregate);
    }
  };
  
  aggregate(props.node);
  return total > 0 ? { unresolved, total } : null;
});
</script>

<template>
  <div class="file-tree-node">
    <div 
      class="node-content"
      :class="{ active: !node.isDir && isSelected, is_dir: node.isDir, viewed: isViewed }"
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
      <div v-if="nodeCommentStats" class="file-badges">
        <span 
          class="badge-unresolved" 
          v-if="nodeCommentStats.unresolved > 0"
        >
          {{ nodeCommentStats.unresolved }}
        </span>
        <span class="badge-total" v-else>
          {{ nodeCommentStats.total }}
        </span>
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
        :sortViewedToBottom="sortViewedToBottom"
        :commentStats="commentStats"
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
.node-content.viewed {
  opacity: 0.5;
}
.node-content.viewed:hover {
  opacity: 0.8;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-badges {
  display: flex;
  gap: 4px;
  margin-left: 8px;
}
.badge-unresolved {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid rgba(248, 81, 73, 0.4);
}
.badge-total {
  background: rgba(139, 148, 158, 0.1);
  color: #8b949e;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
}
</style>
