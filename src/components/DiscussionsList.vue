<script setup lang="ts">
import { computed } from 'vue';
import { useReviewStore } from '../store';
import EmptyState from './EmptyState.vue';

const store = useReviewStore();

// Group discussions by file
const groupedDiscussions = computed(() => {
  const groups: Record<string, any[]> = {};
  store.allDiscussions.forEach(d => {
    const path = d.new_path || 'General';
    if (!groups[path]) groups[path] = [];
    groups[path].push(d);
  });
  return groups;
});

const jumpToDiscussion = (d: any) => {
  if (d.new_path) {
    store.selectFile(d.new_path);
    // Future work: Scroll to line
  }
};

const formatTime = (dateStr: string) => {
  const date = new Date(dateStr);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
</script>

<template>
  <div class="discussions-container">
    <div v-if="store.allDiscussions.length === 0" class="empty-wrap">
      <EmptyState type="no-discussions" />
    </div>
    
    <div v-else class="discussion-groups">
      <div v-for="(discussions, path) in groupedDiscussions" :key="path" class="file-group">
        <div class="file-path">{{ path }}</div>
        <div 
          v-for="d in discussions" 
          :key="d.id" 
          class="discussion-card"
          :class="{ resolved: d.resolved }"
          @click="jumpToDiscussion(d)"
        >
          <div class="card-header">
            <img v-if="d.author.avatar_url" :src="d.author.avatar_url" class="avatar" />
            <span class="author">{{ d.author.name || d.author.username }}</span>
            <span class="time">{{ formatTime(d.updated_at) }}</span>
            <span v-if="d.resolved" class="status-badge">Resolved</span>
          </div>
          <div class="card-body">
             <div class="line-ref" v-if="d.new_line">Line {{ d.new_line }}</div>
             <div class="snippet">{{ d.body.substring(0, 100) }}{{ d.body.length > 100 ? '...' : '' }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.discussions-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.empty-wrap {
  flex: 1;
}

.discussion-groups {
  padding: 12px;
}

.file-group {
  margin-bottom: 2rem;
}

.file-path {
  font-size: 0.75rem;
  font-weight: bold;
  color: #8b949e;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
  padding-bottom: 4px;
  border-bottom: 1px solid #30363d;
}

.discussion-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 0.75rem;
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.discussion-card:hover {
  border-color: #444c56;
  background: #21262d;
}

.discussion-card.resolved {
  opacity: 0.6;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
}

.author {
  font-size: 0.85rem;
  font-weight: 600;
  color: #c9d1d9;
}

.time {
  font-size: 0.7rem;
  color: #8b949e;
  margin-left: auto;
}

.status-badge {
  font-size: 0.65rem;
  background: rgba(46, 160, 67, 0.15);
  color: #3fb950;
  padding: 1px 6px;
  border-radius: 10px;
  border: 1px solid rgba(46, 160, 67, 0.4);
}

.card-body {
  font-size: 0.85rem;
  color: #8b949e;
}

.line-ref {
  font-size: 0.7rem;
  color: #58a6ff;
  margin-bottom: 4px;
}

.snippet {
  line-height: 1.4;
  word-break: break-all;
}
</style>
