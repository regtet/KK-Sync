<template>
  <div class="repo-info">
    <header>
      <div class="title">
        <h2>仓库信息</h2>
        <span v-if="loading" class="badge">加载中...</span>
      </div>
      <div v-if="repoInfo" class="status">
        <span class="pill">
          <span class="dot" :class="repoInfo.isClean ? 'ok' : 'warn'"></span>
          {{ repoInfo.isClean ? '工作区干净' : '存在未提交改动' }}
        </span>
      </div>
    </header>

    <section v-if="repoInfo" class="info-grid">
      <div class="info-item path">
        <span class="label">路径</span>
        <span class="value mono">{{ repoInfo.path }}</span>
      </div>
      <div class="info-item">
        <span class="label">当前分支</span>
        <span class="value accent">{{ repoInfo.currentBranch }}</span>
      </div>
      <div class="info-item">
        <span class="label">Ahead / Behind</span>
        <span class="value">{{ repoInfo.ahead }} / {{ repoInfo.behind }}</span>
      </div>
      <div v-if="remotes.length" class="info-item remote-list">
        <span class="label">远程仓库（{{ remotes.length }}）</span>
        <div class="remote-tags">
          <span v-for="remote in remotes" :key="remote.name" class="remote-tag" :title="remote.url">
            {{ remote.name }}
          </span>
        </div>
      </div>
    </section>

    <section v-else class="empty">
      <p>尚未选择仓库。请先点击上方按钮选择一个 Git 仓库目录。</p>
    </section>
  </div>
</template>

<script setup>
defineProps({
  repoInfo: {
    type: Object,
    default: null
  },
  loading: {
    type: Boolean,
    default: false
  },
  remotes: {
    type: Array,
    default: () => []
  }
});
</script>

<style scoped>
.repo-info {
  display: flex;
  flex-direction: column;
  gap: 18px;
  height: 100%;
}

header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}

.title h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  color: rgba(226, 232, 240, 0.85);
  font-size: 12px;
}

.status {
  display: flex;
  align-items: center;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(96, 165, 250, 0.18);
  color: #dbeafe;
  font-size: 13px;
}

.pill .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--warning);
}

.pill .dot.ok {
  background: var(--success);
}

.pill .dot.warn {
  background: var(--warning);
}

.info-grid {
  display: grid;
  gap: 16px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 18px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  border: 1px solid var(--border);
}

.info-item.path {
  word-break: break-all;
}

.label {
  font-size: 12px;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--text-muted);
}

.value {
  font-size: 16px;
  font-weight: 500;
  color: var(--text);
}

.value.accent {
  color: var(--accent);
}

.mono {
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  font-size: 13px;
}

.remote-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.remote-tag {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent);
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px;
  color: var(--text-muted);
  border: 1px dashed var(--border);
  border-radius: 16px;
  background: color-mix(in srgb, var(--surface) 60%, transparent);
}
</style>
