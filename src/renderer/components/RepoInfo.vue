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
      <div v-if="remotes.length" class="info-item remote-select">
        <span class="label">远程仓库</span>
        <div ref="remotePickerRef" class="remote-picker" :class="{ open: remoteMenuOpen, disabled: loading }">
          <button
            type="button"
            class="remote-trigger"
            :disabled="loading"
            @click="toggleRemoteMenu"
          >
            <span class="remote-current">{{ selectedRemote || '请选择远程' }}</span>
            <span class="remote-chevron" aria-hidden="true"></span>
          </button>
          <transition name="remote-menu">
            <ul v-if="remoteMenuOpen" class="remote-menu scroll-thin">
              <li v-for="remote in remotes" :key="remote.name">
                <button
                  type="button"
                  class="remote-option"
                  :class="{ active: remote.name === selectedRemote }"
                  @click="selectRemote(remote.name)"
                >
                  <span class="remote-name">{{ remote.name }}</span>
                  <span v-if="remote.name === selectedRemote" class="remote-check">✓</span>
                </button>
              </li>
            </ul>
          </transition>
        </div>
      </div>
    </section>

    <section v-else class="empty">
      <p>尚未选择仓库。请先点击上方按钮选择一个 Git 仓库目录。</p>
    </section>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps({
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
  },
  selectedRemote: {
    type: String,
    default: ''
  }
});

const emit = defineEmits(['update:selected-remote']);

const remoteMenuOpen = ref(false);
const remotePickerRef = ref(null);

const closeRemoteMenu = () => {
  remoteMenuOpen.value = false;
};

const toggleRemoteMenu = () => {
  if (props.loading) return;
  remoteMenuOpen.value = !remoteMenuOpen.value;
};

const selectRemote = (remoteName) => {
  closeRemoteMenu();
  if (remoteName !== props.selectedRemote) {
    emit('update:selected-remote', remoteName);
  }
};

const handleDocumentClick = (event) => {
  if (!remotePickerRef.value?.contains(event.target)) {
    closeRemoteMenu();
  }
};

watch(
  () => props.loading,
  (value) => {
    if (value) closeRemoteMenu();
  }
);

onMounted(() => {
  document.addEventListener('click', handleDocumentClick);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick);
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

.remote-picker {
  position: relative;
}

.remote-picker.disabled {
  opacity: 0.7;
}

.remote-trigger {
  width: 100%;
  min-height: 42px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-muted) 88%, transparent);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  transition: border 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.remote-picker.open .remote-trigger,
.remote-trigger:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-muted) 92%, var(--accent) 8%);
}

.remote-picker.open .remote-trigger {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
}

.remote-current {
  font-size: 14px;
  font-weight: 500;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
}

.remote-chevron {
  width: 8px;
  height: 8px;
  border-right: 2px solid var(--text-muted);
  border-bottom: 2px solid var(--text-muted);
  transform: rotate(45deg) translateY(-2px);
  transition: transform 0.2s ease, border-color 0.2s ease;
  flex-shrink: 0;
}

.remote-picker.open .remote-chevron {
  transform: rotate(-135deg) translateY(2px);
  border-color: var(--accent);
}

.remote-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  z-index: 30;
  margin: 0;
  padding: 6px;
  list-style: none;
  border-radius: 14px;
  border: 1px solid var(--border-strong);
  background: color-mix(in srgb, var(--surface) 94%, #000 6%);
  box-shadow:
    0 18px 40px rgba(0, 0, 0, 0.42),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
  max-height: 220px;
  overflow-y: auto;
}

.remote-option {
  width: 100%;
  min-height: 38px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  transition: background 0.18s ease, border 0.18s ease, color 0.18s ease;
}

.remote-option:hover {
  background: color-mix(in srgb, var(--surface-muted) 85%, var(--accent) 15%);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
}

.remote-option.active {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface-muted) 82%);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--text);
}

.remote-name {
  font-size: 13px;
  font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
}

.remote-check {
  font-size: 12px;
  color: var(--accent);
  font-weight: 700;
}

.remote-menu-enter-active,
.remote-menu-leave-active {
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.remote-menu-enter-from,
.remote-menu-leave-to {
  opacity: 0;
  transform: translateY(-6px);
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
