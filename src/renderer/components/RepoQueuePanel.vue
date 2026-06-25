<template>
  <section class="card panel">
    <header class="panel-head">
      <h3>仓库{{ repoIndex }}</h3>
      <div class="head-actions">
        <button class="btn ghost sm" :disabled="loading" @click="selectRepo">
          {{ loading ? '选择中...' : `选择仓库${repoIndex}` }}
        </button>
        <button
          v-if="repoIndex === 2 && repoInfo"
          class="btn ghost sm"
          :disabled="loading"
          @click="clearRepo2"
        >
          清空仓库2
        </button>
      </div>
    </header>

    <div class="layout">
      <div class="left">
        <div class="commit-box">
          <label>各远程提交哈希</label>
          <p class="commit-hint">不同远程库的同一改动对应不同提交，请分别填写</p>
          <div v-if="remotes.length" class="commit-rows">
            <div v-for="remote in remotes" :key="remote.name" class="commit-row">
              <span class="remote-name" :title="remote.url">{{ remote.name }}</span>
              <input
                v-model.trim="commitHashes[remote.name]"
                maxlength="80"
                :placeholder="`输入 ${remote.name} 的提交哈希`"
              />
            </div>
          </div>
          <p v-else class="commit-empty">请先选择仓库以加载远程列表</p>
          <p v-if="missingCommitRemotes.length" class="commit-warn">
            已选分支缺少提交哈希：{{ missingCommitRemotes.join('、') }}
          </p>
        </div>

        <branch-selector
          :branches="branches"
          :repo-index="repoIndex"
          :operation-busy="syncing"
          :hide-source="true"
          v-model:source-branch="sourceBranch"
          v-model:target-branches="selectedTargets"
          @clear-targets="selectedTargets = []"
          @notify="(payload) => emit('notify', payload)"
          @cleanup-duplicates="cleanupDuplicateBranches"
          @branches-changed="handleBranchesChanged"
        />

      </div>

      <div class="right">
        <RepoInfo
          :repo-info="repoInfo"
          :loading="loading"
          :remotes="remotes"
        />
        <div class="actions">
          <button
            v-if="syncing"
            class="btn danger sync-btn"
            @click="cancelSync"
          >
            中止
          </button>
          <button
            class="btn primary sync-btn"
            :disabled="isSyncDisabled"
            @click="startSync"
          >
            {{ syncButtonLabel }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import BranchSelector from './BranchSelector.vue';
import RepoInfo from './RepoInfo.vue';

const props = defineProps({
  repoIndex: { type: Number, required: true },
  syncProgress: { type: Object, default: null }
});

const emit = defineEmits(['notify', 'sync-change', 'log']);

const DUPLICATE_WARN_TEXT =
  '警告：分支名 {names} 在多个远程仓库中重复，请勾选时认准远程分组，或批量粘贴时使用 远程/分支 格式。';

const repoLog = (message, level = 'info') => {
  emit('log', {
    message: `[仓库${props.repoIndex}] ${message}`,
    level,
    timestamp: new Date().toISOString(),
    repoIndex: props.repoIndex
  });
};

const logDuplicateWarning = (dupes = []) => {
  if (!dupes.length) return;
  repoLog(DUPLICATE_WARN_TEXT.replace('{names}', dupes.join('、')), 'warn');
};

const repoInfo = ref(null);
const remotes = ref([]);
const branches = ref({ groups: [], duplicates: [], current: '' });
const sourceBranch = ref('');
const selectedTargets = ref([]);
const commitHashes = ref({});
const loading = ref(false);
const syncing = ref(false);

const getRemotesFromTargets = (targets = []) => {
  const set = new Set();
  for (const target of targets) {
    const raw = String(target ?? '').trim();
    const slash = raw.indexOf('/');
    if (slash > 0) set.add(raw.slice(0, slash));
  }
  return [...set];
};

const requiredCommitRemotes = computed(() => getRemotesFromTargets(selectedTargets.value));

const missingCommitRemotes = computed(() =>
  requiredCommitRemotes.value.filter((remote) => !String(commitHashes.value[remote] || '').trim())
);

const isSyncDisabled = computed(() => {
  if (syncing.value) return true;
  if (!repoInfo.value) return true;
  if (!selectedTargets.value.length) return true;
  if (missingCommitRemotes.value.length) return true;
  return false;
});

const syncButtonLabel = computed(() => {
  if (!syncing.value) return '一键同步';
  const progress = props.syncProgress;
  if (!progress?.total) return '同步中...';
  const current = Math.min(progress.current || 0, progress.total);
  return `同步中 ${current}/${progress.total}...`;
});

const notify = (type, message) => emit('notify', { type, message });

const migrateTargetBranches = (targets = [], fallbackRemote = '') => {
  if (!Array.isArray(targets)) return [];
  return targets.map((target) => {
    const raw = String(target ?? '').trim();
    if (!raw) return '';
    if (raw.includes('/')) return raw;
    return fallbackRemote ? `${fallbackRemote}/${raw}` : raw;
  }).filter(Boolean);
};

const normalizeBranchGroups = (payload) => ({
  groups: payload?.groups ?? [],
  duplicates: payload?.duplicates ?? [],
  current: payload?.current ?? ''
});

const syncCommitHashesWithRemotes = () => {
  const next = { ...commitHashes.value };
  for (const remote of remotes.value) {
    if (!(remote.name in next)) next[remote.name] = '';
  }
  commitHashes.value = next;
};

const applyCommitHashesFromSession = (session) => {
  if (session?.commitHashes && typeof session.commitHashes === 'object') {
    commitHashes.value = { ...session.commitHashes };
    syncCommitHashesWithRemotes();
    return;
  }
  if (session?.commitHash) {
    const next = { ...commitHashes.value };
    for (const remote of remotes.value) {
      if (!next[remote.name]) next[remote.name] = session.commitHash;
    }
    commitHashes.value = next;
  }
};

const applyRepoResult = async (result, { resetTargets = false } = {}) => {
  repoInfo.value = result.repo ?? null;
  remotes.value = result.remotes ?? await loadRemotes();
  branches.value = normalizeBranchGroups(result.branches ?? await loadBranchGroups());

  if (resetTargets) {
    selectedTargets.value = [];
    sourceBranch.value = '';
  }

  const session = result.session;
  applyCommitHashesFromSession(session);
  if (!resetTargets && Array.isArray(session?.targetBranches) && session.targetBranches.length) {
    selectedTargets.value = migrateTargetBranches(session.targetBranches, session.remote);
  }

  logDuplicateWarning(branches.value.duplicates ?? []);
};

const persistSession = async () => {
  if (!repoInfo.value || !window.electronAPI?.saveRepoSession) return;
  await window.electronAPI.saveRepoSession({
    repoIndex: props.repoIndex,
    commitHashes: { ...commitHashes.value },
    targetBranches: [...selectedTargets.value]
  });
};

let persistTimer = null;
const schedulePersistSession = () => {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistSession();
  }, 300);
};

const loadRemotes = async () => {
  if (!window.electronAPI?.listRemotes) return [];
  const result = await window.electronAPI.listRemotes(props.repoIndex);
  if (!result?.ok) {
    throw new Error(result?.error || `仓库${props.repoIndex} 远程列表读取失败`);
  }
  return result.data ?? [];
};

const loadBranchGroups = async () => {
  if (!window.electronAPI?.listBranches) {
    return { groups: [], duplicates: [], current: '' };
  }
  const branchResult = await window.electronAPI.listBranches(props.repoIndex);
  if (!branchResult?.ok) {
    throw new Error(branchResult?.error || `仓库${props.repoIndex} 分支列表读取失败`);
  }
  const warnings = branchResult.data?.fetchWarnings;
  if (Array.isArray(warnings) && warnings.length) {
    warnings.forEach((warning) => repoLog(warning, 'warn'));
  }
  return branchResult.data ?? { groups: [], duplicates: [], current: '' };
};

const refreshBranches = async () => {
  branches.value = normalizeBranchGroups(await loadBranchGroups());
  logDuplicateWarning(branches.value.duplicates ?? []);
};

const handleBranchesChanged = async (deletedKeys = []) => {
  if (deletedKeys.length) {
    const removed = new Set(deletedKeys);
    selectedTargets.value = selectedTargets.value.filter((ref) => !removed.has(ref));
  }
  await refreshBranches();
};

const cleanupDuplicateBranches = async () => {
  if (syncing.value || !window.electronAPI?.deleteStaleDuplicateBranches) return;

  syncing.value = true;
  emit('sync-change', { repoIndex: props.repoIndex, syncing: true });

  try {
    const response = await window.electronAPI.deleteStaleDuplicateBranches(props.repoIndex);
    if (!response?.ok) {
      repoLog(`清理重名分支失败：${response?.error || '未知错误'}`, 'error');
      return;
    }

    const deleted = response.data?.deleted ?? [];
    if (deleted.length) {
      await handleBranchesChanged(deleted.map((item) => item.key));
    }
  } catch (error) {
    repoLog(`清理重名分支异常：${error?.message || '未知错误'}`, 'error');
  } finally {
    syncing.value = false;
    emit('sync-change', { repoIndex: props.repoIndex, syncing: false });
  }
};

const restoreRepo = async () => {
  if (!window.electronAPI?.restoreRepository) return false;
  loading.value = true;
  try {
    const result = await window.electronAPI.restoreRepository(props.repoIndex);
    if (!result?.ok) return false;
    await applyRepoResult(result);
    return true;
  } catch (error) {
    notify('error', error?.message || `仓库${props.repoIndex} 自动恢复失败`);
    return false;
  } finally {
    loading.value = false;
  }
};

const refresh = async () => {
  if (!window.electronAPI?.hasRepository) return;
  const hasResult = await window.electronAPI.hasRepository(props.repoIndex);
  if (!hasResult?.ok || !hasResult.hasRepo) return;
  loading.value = true;
  try {
    const info = await window.electronAPI.getRepositoryInfo(props.repoIndex);
    if (info?.ok) repoInfo.value = info.data;
    remotes.value = await loadRemotes();
    await refreshBranches();
  } catch (error) {
    notify('error', error?.message || `仓库${props.repoIndex} 信息读取失败`);
  } finally {
    loading.value = false;
  }
};

const selectRepo = async () => {
  const fn = props.repoIndex === 2
    ? window.electronAPI?.selectRepository2
    : window.electronAPI?.selectRepository;
  if (!fn) return;
  loading.value = true;
  try {
    const result = await fn();
    if (result?.canceled) return;
    if (result?.error) {
      notify('error', result.error);
      return;
    }
    await applyRepoResult(result, { resetTargets: true });
    schedulePersistSession();
    notify('success', `仓库${props.repoIndex} 选择成功`);
  } finally {
    loading.value = false;
  }
};

const clearRepo2 = async () => {
  if (props.repoIndex !== 2 || !window.electronAPI?.clearRepository2) return;
  loading.value = true;
  try {
    const res = await window.electronAPI.clearRepository2();
    if (!res?.ok) {
      notify('error', res?.error || '清空仓库2失败');
      return;
    }
    repoInfo.value = null;
    remotes.value = [];
    branches.value = { groups: [], duplicates: [], current: '' };
    sourceBranch.value = '';
    selectedTargets.value = [];
    commitHashes.value = {};
    notify('success', '仓库2已清空');
  } finally {
    loading.value = false;
  }
};

const startSync = async () => {
  emit('sync-change', { repoIndex: props.repoIndex, syncing: true });
  syncing.value = true;
  try {
    const payload = {
      repoIndex: props.repoIndex,
      mode: 'commit',
      commitHashes: { ...commitHashes.value },
      targetBranches: [...selectedTargets.value]
    };
    const response = await window.electronAPI.startSync(payload);
    if (!response?.ok) {
      notify('error', response?.error || `仓库${props.repoIndex} 同步失败`);
    }
  } catch (error) {
    notify('error', error?.message || `仓库${props.repoIndex} 同步异常`);
  } finally {
    syncing.value = false;
    emit('sync-change', { repoIndex: props.repoIndex, syncing: false });
  }
};

const cancelSync = async () => {
  try {
    const res = await window.electronAPI.cancelSync(props.repoIndex);
    if (!res?.ok) {
      notify('error', res?.error || `仓库${props.repoIndex} 中止失败`);
    } else {
      notify('warn', `仓库${props.repoIndex} 已发出中止指令`);
    }
  } catch (error) {
    notify('error', error?.message || `仓库${props.repoIndex} 中止失败`);
  }
};

onMounted(async () => {
  const restored = await restoreRepo();
  if (restored) {
    notify('success', `已自动恢复仓库${props.repoIndex}`);
  } else {
    await refresh();
  }
});

watch(remotes, () => {
  syncCommitHashesWithRemotes();
}, { deep: true });

watch([commitHashes, selectedTargets], () => {
  schedulePersistSession();
}, { deep: true });

defineExpose({
  refresh,
  startSync,
  cancelSync
});
</script>

<style scoped>
.panel {
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  gap: 24px;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-head h3 {
  margin: 0;
  font-size: 15px;
}

.head-actions {
  display: flex;
  gap: 8px;
}

.layout {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 24px;
}

.left {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.right {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.actions {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.sync-btn {
  width: 180px;
  border-radius: 12px;
}

.commit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.commit-box label {
  font-size: 12px;
  color: var(--text-muted);
}

.commit-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.commit-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.commit-row {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
}

.remote-name {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 13px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.commit-empty,
.commit-warn {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
}

.commit-empty {
  color: var(--text-muted);
}

.commit-warn {
  color: var(--warning);
}

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
