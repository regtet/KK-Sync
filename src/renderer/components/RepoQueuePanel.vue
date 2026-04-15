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
          <label>提交哈希</label>
          <input
            v-model.trim="commitHash"
            maxlength="80"
            placeholder="输入需要同步的提交哈希，例如 f6efc42cb115..."
          />
        </div>

        <branch-selector
          :branches="branches"
          :repo-index="repoIndex"
          :hide-source="true"
          v-model:source-branch="sourceBranch"
          v-model:target-branches="selectedTargets"
          @clear-targets="selectedTargets = []"
        />

      </div>

      <div class="right">
        <repo-info :repo-info="repoInfo" :loading="loading" />
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
            {{ syncing ? '同步中...' : '一键同步' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import BranchSelector from './BranchSelector.vue';
import RepoInfo from './RepoInfo.vue';

const props = defineProps({
  repoIndex: { type: Number, required: true }
});

const emit = defineEmits(['notify', 'sync-change']);

const repoInfo = ref(null);
const branches = ref({ list: [], current: '' });
const sourceBranch = ref('');
const selectedTargets = ref([]);
const commitHash = ref('');
const loading = ref(false);
const syncing = ref(false);

const isSyncDisabled = computed(() => {
  if (syncing.value) return true;
  if (!repoInfo.value) return true;
  if (!commitHash.value) return true;
  if (!selectedTargets.value.length) return true;
  return false;
});

const notify = (type, message) => emit('notify', { type, message });
const normalizeBranches = (payload) => ({
  list: payload?.list ?? payload?.branches ?? [],
  current: payload?.current ?? ''
});

const refresh = async () => {
  if (!window.electronAPI?.hasRepository) return;
  const hasResult = await window.electronAPI.hasRepository(props.repoIndex);
  if (!hasResult?.ok || !hasResult.hasRepo) return;
  loading.value = true;
  try {
    const info = await window.electronAPI.getRepositoryInfo(props.repoIndex);
    if (info?.ok) repoInfo.value = info.data;
    const branchResult = await window.electronAPI.listBranches(props.repoIndex);
    if (branchResult?.ok) {
      branches.value = normalizeBranches(branchResult.data);
      if (!sourceBranch.value) sourceBranch.value = branches.value.current;
    }
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
    repoInfo.value = result.repo ?? null;
    branches.value = normalizeBranches(result.branches);
    sourceBranch.value = branches.value.current || '';
    selectedTargets.value = [];
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
    branches.value = { list: [], current: '' };
    sourceBranch.value = '';
    selectedTargets.value = [];
    commitHash.value = '';
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
      commitHash: commitHash.value,
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

onMounted(refresh);

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

@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
}
</style>
