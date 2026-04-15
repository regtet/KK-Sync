<template>
  <div class="app-shell">
    <header class="toolbar">
      <div class="title">
        <img class="app-logo" :src="appLogo" alt="KK Sync Logo" />
        <span class="title-text">KK Sync</span>
      </div>
      <div class="actions">
        <div class="theme-toggle">
          <button
            v-for="theme in themes"
            :key="theme.value"
            :class="['theme-option', { active: currentTheme === theme.value }]"
            @click="setTheme(theme.value)"
          >
            <span class="theme-dot" :style="{ background: theme.preview }"></span>
            {{ theme.label }}
          </button>
        </div>
        <div class="tabs">
          <button :class="['tab', { active: activeTab === 1 }]" @click="activeTab = 1">仓库1队列</button>
          <button :class="['tab', { active: activeTab === 2 }]" @click="activeTab = 2">仓库2队列</button>
        </div>
      </div>
    </header>

    <transition-group name="toast" tag="div" class="toast-stack">
      <div v-for="note in notifications" :key="note.id" class="toast" :class="note.type">
        <span class="dot"></span>
        <span class="text">{{ note.message }}</span>
        <button class="toast-close" @click="dismissNotification(note.id)">×</button>
      </div>
    </transition-group>

    <main class="content">
      <div class="panel-area">
        <repo-queue-panel
          v-show="activeTab === 1"
          ref="panel1Ref"
          :repo-index="1"
          @notify="handleNotify"
          @sync-change="handleSyncChange"
        />
        <repo-queue-panel
          v-show="activeTab === 2"
          ref="panel2Ref"
          :repo-index="2"
          @notify="handleNotify"
          @sync-change="handleSyncChange"
        />
      </div>

      <section class="card log-card">
        <log-view :logs="activeLogs" :syncing="!!syncingState[activeTab]" @clear="clearLogs" />
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import RepoQueuePanel from './components/RepoQueuePanel.vue';
import LogView from './components/LogView.vue';
import appLogo from '../assets/img/logo.png';

const themes = [
  { value: 'abyss', label: '深空', preview: '#3b82f6' },
  { value: 'aurora', label: '极光', preview: '#10b981' }
];

const activeTab = ref(1);
const logsByRepo = ref({ 1: [], 2: [] });
const syncingState = ref({ 1: false, 2: false });
const panel1Ref = ref(null);
const panel2Ref = ref(null);

const notifications = ref([]);
const currentTheme = ref(localStorage.getItem('gsv-theme') || themes[0].value);

const pushNotification = (type, message) => {
  if (!message) return;
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  notifications.value.push({ id, type, message });
  setTimeout(() => {
    dismissNotification(id);
  }, 4000);
};

const dismissNotification = (id) => {
  notifications.value = notifications.value.filter((item) => item.id !== id);
};

const setTheme = (theme) => {
  currentTheme.value = theme;
};

const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);
};

watch(
  currentTheme,
  (theme) => {
    applyTheme(theme);
    localStorage.setItem('gsv-theme', theme);
  },
  { immediate: true }
);

const resolveModeLabel = (mode) => {
  switch (mode) {
    case 'commit':
      return '精准提交';
    default:
      return mode || '未知模式';
  }
};

let disposeLogListener = null;
let disposeStatusListener = null;

const detectRepoIndex = (log) => {
  if (log?.repoIndex === 1 || log?.repoIndex === 2) {
    return log.repoIndex;
  }
  const text = typeof log?.message === 'string' ? log.message : '';
  const match = text.match(/\[仓库([12])\]/);
  if (match) {
    return Number(match[1]);
  }
  return activeTab.value;
};

const appendLog = (log) => {
  const repoIndex = detectRepoIndex(log);
  const currentLogs = logsByRepo.value[repoIndex] ?? [];
  const nextLogs = [...currentLogs, { ...log, repoIndex }];
  // 防止长时间运行日志无限增长导致渲染卡顿
  logsByRepo.value = {
    ...logsByRepo.value,
    [repoIndex]: nextLogs.length > 1200 ? nextLogs.slice(-1000) : nextLogs
  };
};

const handleNotify = ({ type, message }) => pushNotification(type, message);
const handleSyncChange = ({ repoIndex, syncing }) => {
  syncingState.value = { ...syncingState.value, [repoIndex]: syncing };
};

const clearLogs = () => {
  logsByRepo.value = {
    ...logsByRepo.value,
    [activeTab.value]: []
  };
};

const activeLogs = computed(() => logsByRepo.value[activeTab.value] ?? []);

const summarizeResults = (results, modeLabel, repoIndex) => {
  if (!Array.isArray(results) || results.length === 0) {
    appendLog({
      message: `[仓库${repoIndex}] 同步任务已完成（${modeLabel}）：无有效目标分支`,
      level: 'warn',
      timestamp: new Date().toISOString()
    });
    return;
  }

  const oks = results.filter((item) => item.success);
  const fails = results.filter((item) => !item.success);

  const now = new Date().toISOString();

  // 显示成功统计（合并为一条日志）
  if (oks.length > 0) {
    const successBranches = oks.map((item) => item.branch).join('\n');
    appendLog({
      message: `[仓库${repoIndex}] 成功 ${oks.length} 条\n${successBranches}`,
      level: 'info',
      timestamp: now
    });
  }

  // 显示失败统计（合并为一条日志）
  if (fails.length > 0) {
    const failBranches = fails.map((item) => item.branch).join('\n');
    appendLog({
      message: `[仓库${repoIndex}] 失败 ${fails.length} 条\n${failBranches}`,
      level: 'error',
      timestamp: now
    });
    pushNotification('error', `[仓库${repoIndex}] 同步失败 ${fails.length} 个分支`);
  } else {
    pushNotification('success', `[仓库${repoIndex}] 同步完成：成功 ${oks.length} 个分支`);
  }
};

onMounted(() => {
  disposeLogListener = window.electronAPI?.onSyncLog((log) => {
    appendLog(log);
  });
  disposeStatusListener = window.electronAPI?.onSyncStatus((status) => {
    if (!status) return;
    const now = new Date().toISOString();
    const modeLabel = resolveModeLabel(status.mode);
    const repoIndex = status.repoIndex ?? 1;
    switch (status.status) {
      case 'running':
        syncingState.value = { ...syncingState.value, [repoIndex]: true };
        appendLog({
          message: `[仓库${repoIndex}] 同步任务已启动（${modeLabel}）`,
          level: 'info',
          timestamp: now
        });
        break;
      case 'completed':
        syncingState.value = { ...syncingState.value, [repoIndex]: false };
        summarizeResults(status.results, modeLabel, repoIndex);
        if (repoIndex === 1) panel1Ref.value?.refresh?.();
        if (repoIndex === 2) panel2Ref.value?.refresh?.();
        break;
      case 'cancelled':
        syncingState.value = { ...syncingState.value, [repoIndex]: false };
        appendLog({
          message: `[仓库${repoIndex}] 同步任务已被用户中止（${modeLabel}）`,
          level: 'warn',
          timestamp: now
        });
        summarizeResults(status.results, modeLabel, repoIndex);
        if (repoIndex === 1) panel1Ref.value?.refresh?.();
        if (repoIndex === 2) panel2Ref.value?.refresh?.();
        pushNotification('warn', '同步已中止');
        break;
      case 'failed':
        syncingState.value = { ...syncingState.value, [repoIndex]: false };
        appendLog({
          message: `[仓库${repoIndex}] 同步任务失败（${modeLabel}）: ${status.message || '未知错误'}`,
          level: 'error',
          timestamp: now
        });
        pushNotification('error', status.message || '同步失败');
        break;
      default:
        syncingState.value = { ...syncingState.value, [repoIndex]: false };
    }
  });
});

onBeforeUnmount(() => {
  disposeLogListener?.();
  disposeStatusListener?.();
});
</script>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  color: #f5f5f5;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 28px;
  background:
    linear-gradient(120deg, rgba(251, 191, 36, 0.12) 0%, rgba(59, 130, 246, 0.08) 55%, rgba(16, 185, 129, 0.08) 100%),
    rgba(18, 22, 32, 0.82);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.6px;
}

.title-text {
  color: rgba(241, 245, 249, 0.95);
  text-shadow: 0 1px 10px rgba(56, 189, 248, 0.15);
}

.app-logo {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.28);
}

.actions {
  display: inline-flex;
  gap: 12px;
  align-items: center;
}

.theme-toggle {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.theme-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 999px;
  border: none;
  background: transparent;
  color: rgba(226, 232, 240, 0.7);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}

.theme-option.active {
  background: rgba(148, 163, 184, 0.18);
  color: #e2e8f0;
}

.theme-option:hover {
  color: #f8fafc;
}

.theme-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  box-shadow: 0 0 8px rgba(148, 163, 184, 0.4);
}

.toast-stack {
  position: fixed;
  top: 24px;
  right: 28px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  z-index: 1000;
}

.toast {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  background: rgba(30, 41, 59, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
  min-width: 240px;
}

.toast.success {
  border-color: rgba(52, 211, 153, 0.35);
}

.toast.error {
  border-color: rgba(248, 113, 113, 0.35);
}

.toast .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(148, 163, 184, 0.6);
}

.toast.success .dot {
  background: #34d399;
}

.toast.error .dot {
  background: #f87171;
}

.toast .text {
  flex: 1;
  font-size: 14px;
  color: rgba(241, 245, 249, 0.92);
}

.toast-close {
  background: none;
  border: none;
  color: rgba(148, 163, 184, 0.8);
  font-size: 18px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.toast-close:hover {
  color: rgba(226, 232, 240, 0.95);
}

.content {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(360px, 1fr);
  gap: 24px;
  padding: 24px 80px;
  overflow: hidden;
  align-items: stretch;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 18px;
  min-height: 0;
}

.panel-area {
  min-height: 0;
  overflow: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.panel-area::-webkit-scrollbar {
  display: none;
}

.log-card {
  min-width: 0;
  height: 100%;
}

.log-card :deep(.log-view) {
  height: 100%;
  min-height: 0;
}

@media (max-width: 1400px) {
  .content {
    grid-template-columns: 1fr;
    overflow: auto;
  }

  .log-card {
    min-height: 280px;
  }
}

.tabs {
  display: inline-flex;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 12px;
  gap: 4px;
  padding: 4px;
}

.tab {
  background: transparent;
  color: var(--text-muted);
  border-radius: 10px;
  padding: 8px 12px;
  font-size: 13px;
  transition: all 0.2s ease;
}

.tab.active {
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: #fff;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-12px);
}
</style>
