<template>
  <div class="branch-selector">
    <header>
      <h2>分支选择</h2>
    </header>
    <section v-if="hasBranchGroups" class="fields">
      <div v-if="!props.hideSource" class="field">
        <label for="source-branch">源分支</label>
        <select id="source-branch" v-model="localSource" @change="onSourceChange">
          <option disabled value="">请选择源分支</option>
          <option
            v-for="branch in flatBranchNames"
            :key="branch"
            :value="branch"
          >
            {{ branch }}
          </option>
        </select>
      </div>
      <div class="field target-field">
        <label>目标分支（按远程仓库分组）</label>
        <p v-if="duplicateWarning" class="dup-warning">{{ duplicateWarning }}</p>
        <input
          v-model.trim="targetSearch"
          type="search"
          class="search-input"
          placeholder="筛选远程或分支名，如 origin / dev"
        />
        <textarea
          v-model="bulkInput"
          class="bulk-input"
          placeholder="批量粘贴分支名，支持换行或逗号分隔；重名分支请写 远程/分支，如 origin/dev"
        ></textarea>
        <div class="bulk-actions">
          <button type="button" class="bulk-btn" :disabled="checkingRemote" @click="applyBulkInput">
            {{ checkingRemote ? '查询中...' : '查询' }}
          </button>
          <button type="button" class="bulk-btn secondary" @click="openSheetModal">
            从表格导入
          </button>
          <button type="button" class="bulk-btn secondary" @click="clearTargets">
            清空已选
          </button>
          <button
            v-if="duplicateSet.size"
            type="button"
            class="bulk-btn danger"
            :disabled="operationBusy"
            @click="emit('cleanup-duplicates')"
          >
            删除重名旧分支
          </button>
          <span v-if="bulkFeedback" class="bulk-feedback">{{ bulkFeedback }}</span>
        </div>
        <div class="target-list scroll-thin">
          <template v-for="group in visibleGroups" :key="group.remote">
            <div class="remote-group-header">{{ group.remote }}</div>
            <label
              v-for="ref in group.items"
              :key="ref"
              class="checkbox target-item"
              :class="{ 'is-dup': isDuplicateRef(ref) }"
            >
              <input
                type="checkbox"
                :value="ref"
                v-model="localTargets"
              />
              <span class="branch-label" :title="ref">{{ branchLabel(ref) }}</span>
            </label>
          </template>
          <p v-if="!visibleGroups.length" class="empty-filter">暂无匹配分支</p>
        </div>
      </div>
    </section>
    <section v-else class="empty">
      <p>暂无分支信息，请先选择一个 Git 仓库。</p>
    </section>

    <google-sheet-modal
      v-model:visible="sheetModalVisible"
      :repo-index="repoIndex"
      @confirm="handleSheetImport"
    />
  </div>
</template>

<script setup>
import { computed, watch, ref } from 'vue';
import GoogleSheetModal from './GoogleSheetModal.vue';

const props = defineProps({
  branches: {
    type: Object,
    default: () => ({ groups: [], duplicates: [], current: '' })
  },
  sourceBranch: {
    type: String,
    default: ''
  },
  targetBranches: {
    type: Array,
    default: () => []
  },
  hideSource: {
    type: Boolean,
    default: false
  },
  repoIndex: {
    type: Number,
    default: 1
  },
  operationBusy: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits([
  'update:source-branch',
  'update:target-branches',
  'clear-targets',
  'notify',
  'cleanup-duplicates'
]);

const localSource = ref(props.sourceBranch);
const localTargets = ref([...props.targetBranches]);
const targetSearch = ref('');
const bulkInput = ref('');
const bulkFeedback = ref('');
const checkingRemote = ref(false);
const sheetModalVisible = ref(false);

const branchGroups = computed(() => props.branches?.groups ?? []);

const hasBranchGroups = computed(() => branchGroups.value.some((g) => g.branches?.length));

const duplicateSet = computed(
  () => new Set((props.branches?.duplicates ?? []).map((name) => name.toLowerCase()))
);

const duplicateWarning = computed(() => {
  const dups = props.branches?.duplicates ?? [];
  if (!dups.length) return '';
  return `警告：分支名 ${dups.join('、')} 在多个远程仓库中重复，请勾选时认准远程分组，或批量粘贴时使用 远程/分支 格式。`;
});

const flatBranchNames = computed(() => {
  const names = new Set();
  for (const group of branchGroups.value) {
    for (const branch of group.branches ?? []) {
      names.add(branch);
    }
  }
  return [...names].sort();
});

const toRefKey = (remote, branch) => `${remote}/${branch}`;

const branchLabel = (ref) => {
  const slash = ref.indexOf('/');
  if (slash < 0) return ref;
  return ref.slice(slash + 1);
};

const isDuplicateRef = (ref) => {
  const branch = branchLabel(ref);
  return duplicateSet.value.has(branch.toLowerCase());
};

const visibleGroups = computed(() => {
  const keyword = targetSearch.value.trim().toLowerCase();
  const selectedSet = new Set(localTargets.value);
  const previewLimit = 120;

  return branchGroups.value
    .map((group) => {
      let items = (group.branches ?? []).map((branch) => toRefKey(group.remote, branch));
      if (keyword) {
        items = items.filter((ref) => ref.toLowerCase().includes(keyword));
      } else {
        const selectedInGroup = items.filter((ref) => selectedSet.has(ref));
        const unselected = items.filter((ref) => !selectedSet.has(ref));
        items = [...selectedInGroup, ...unselected.slice(0, previewLimit)];
      }
      return { remote: group.remote, items };
    })
    .filter((group) => group.items.length);
});

const openSheetModal = () => {
  sheetModalVisible.value = true;
};

const handleSheetImport = async (branchNames = []) => {
  if (!Array.isArray(branchNames) || !branchNames.length) return;
  bulkInput.value = branchNames.join('\n');
  bulkFeedback.value = `已从表格导入 ${branchNames.length} 个项目名，正在查询远程分支…`;
  await applyBulkInput();
};

const arraysEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const emitTargetBranches = (value) => {
  if (!arraysEqual(value, props.targetBranches)) {
    emit('update:target-branches', value);
  }
};

watch(
  () => props.sourceBranch,
  (value) => {
    localSource.value = value;
  }
);

watch(
  () => props.targetBranches,
  (value) => {
    localTargets.value = [...value];
  }
);

watch(localTargets, (value) => {
  emitTargetBranches(value);
});

const sanitizeBranchName = (value = '') => {
  if (!value) return '';

  let v = value;
  v = v.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');
  v = v.replace(/\s*[-–—]?\s*[0-9一二三四五六七八九十百千万]+倍\s*$/u, '');
  return v.trim();
};

const applyBulkInput = async () => {
  if (checkingRemote.value) return;
  const entries = bulkInput.value
    .split(/[\r\n,，、;；\t]+/)
    .map((line) => sanitizeBranchName(line))
    .filter(Boolean);

  if (!entries.length) {
    bulkFeedback.value = '请输入有效的分支名称';
    return;
  }

  bulkFeedback.value = '正在查询所有远程仓库的分支...';
  checkingRemote.value = true;

  try {
    if (!window.electronAPI?.checkRemoteBranches) {
      bulkFeedback.value = '当前环境不支持远程分支查询';
      return;
    }

    const result = await window.electronAPI.checkRemoteBranches(
      entries,
      props.repoIndex,
      null
    );

    if (!result?.ok) {
      bulkFeedback.value = `查询失败：${result?.error || '未知错误'}`;
      return;
    }

    const { exists, notExists, ambiguous } = result.data || {
      exists: [],
      notExists: [],
      ambiguous: []
    };

    if (exists.length > 0) {
      const merged = Array.from(new Set([...localTargets.value, ...exists]));
      localTargets.value = merged;
      emitTargetBranches(merged);
    }

    const parts = [];
    if (exists.length > 0) {
      parts.push(`已添加 ${exists.length} 个`);
    }
    if (ambiguous.length > 0) {
      parts.push(
        `重名未自动添加：${ambiguous
          .map((item) => `${item.name}(${item.remotes.join('/')})`)
          .join('；')}`
      );
      emit('notify', {
        type: 'warn',
        message: `分支重名：${ambiguous.map((item) => item.name).join('、')}，请手动勾选或写 远程/分支`
      });
    }
    if (notExists.length > 0) {
      parts.push(`未找到：${notExists.join('，')}`);
    }

    bulkFeedback.value = parts.length ? parts.join('；') : '未添加任何分支';
  } catch (error) {
    bulkFeedback.value = `查询远程分支失败：${error?.message || '未知错误'}`;
  } finally {
    checkingRemote.value = false;
  }
};

const clearTargets = () => {
  localTargets.value = [];
  emitTargetBranches([]);
  emit('clear-targets');
  bulkFeedback.value = '已清空所有目标分支';
};

const onSourceChange = () => {
  emit('update:source-branch', localSource.value);
  const branch = localSource.value;
  const removed = localTargets.value.filter((ref) => branchLabel(ref) !== branch);
  if (removed.length !== localTargets.value.length) {
    localTargets.value = removed;
    emitTargetBranches(removed);
  }
};
</script>

<style scoped>
.branch-selector {
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: 0.4px;
}

.fields {
  display: flex;
  flex-direction: column;
  gap: 22px;
  flex: 1;
  min-height: 0;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.field label {
  font-size: 13px;
  letter-spacing: 0.2px;
  color: rgba(255, 255, 255, 0.68);
}

.dup-warning {
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
}

select {
  width: 100%;
  min-height: 44px;
  appearance: none;
}

.search-input {
  width: 100%;
  margin-top: -4px;
  margin-bottom: 6px;
  padding: 10px 14px;
}

.bulk-input {
  width: 100%;
  min-height: 88px;
  resize: vertical;
  margin-top: 6px;
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-muted) 80%, transparent);
  color: var(--text);
}

.bulk-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin: 8px 0 4px;
}

.bulk-btn {
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
  color: var(--text);
  cursor: pointer;
  transition: background 0.2s ease, border 0.2s ease;
}

.bulk-btn.secondary {
  background: transparent;
}

.bulk-btn.secondary:hover {
  background: color-mix(in srgb, var(--surface-muted) 60%, transparent);
}

.bulk-btn.danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

.bulk-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 18%, transparent);
  border-color: color-mix(in srgb, var(--danger) 55%, var(--border));
}

.bulk-btn:hover {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-muted) 82%, transparent);
}

.bulk-feedback {
  font-size: 12px;
  color: var(--warning);
}

.target-field {
  flex: 1;
  min-height: 0;
}

.target-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 160px;
  max-height: 320px;
  padding: 12px;
  background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
  border-radius: 14px;
  border: 1px dashed var(--border);
  overflow-y: auto;
  overflow-x: hidden;
}

.remote-group-header {
  margin-top: 8px;
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent);
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.remote-group-header:first-child {
  margin-top: 0;
}

.target-list .target-item {
  display: flex;
  margin-left: 4px;
}

.target-item {
  justify-content: flex-start;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-muted) 85%, transparent);
  border: 1px solid transparent;
  transition: border 0.2s ease, background 0.2s ease;
}

.target-item.is-dup {
  border-color: color-mix(in srgb, var(--warning) 40%, transparent);
}

.target-item:hover {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-muted) 92%, var(--accent) 8%);
}

.branch-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
}

.empty-filter {
  margin: 12px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: rgba(255, 255, 255, 0.6);
}
</style>
