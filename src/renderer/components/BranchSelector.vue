<template>
  <div class="branch-selector">
    <header>
      <h2>分支选择</h2>
    </header>
    <section v-if="branchList.length" class="fields">
      <div v-if="!props.hideSource" class="field">
        <label for="source-branch">源分支</label>
        <select id="source-branch" v-model="localSource" @change="onSourceChange">
          <option disabled value="">请选择源分支</option>
          <option
            v-for="branch in branchList"
            :key="branch"
            :value="branch"
          >
            {{ branch }}
          </option>
        </select>
      </div>
      <div class="field target-field">
        <label>目标分支</label>
        <input
          v-model.trim="targetSearch"
          type="search"
          class="search-input"
          placeholder="输入关键字快速筛选目标分支"
        />
        <textarea
          v-model="bulkInput"
          class="bulk-input"
          placeholder="批量粘贴分支名，每行一个，支持去除括号备注"
          @paste="handleBulkPaste"
        ></textarea>
        <div class="bulk-actions">
          <button type="button" class="bulk-btn" :disabled="checkingRemote" @click="applyBulkInput">
            {{ checkingRemote ? '添加中...' : '添加到目标分支' }}
          </button>
          <button type="button" class="bulk-btn secondary" @click="clearTargets">
            清空已选
          </button>
          <span v-if="bulkFeedback" class="bulk-feedback">{{ bulkFeedback }}</span>
        </div>
        <div class="target-list scroll-thin">
          <label
            v-for="branch in filteredTargets"
            :key="branch"
            class="checkbox target-item"
          >
            <input
              type="checkbox"
              :value="branch"
              v-model="localTargets"
            />
            <span>{{ branch }}</span>
          </label>
        </div>
      </div>
    </section>
    <section v-else class="empty">
      <p>暂无分支信息，请先选择一个 Git 仓库。</p>
    </section>
  </div>
</template>

<script setup>
import { computed, watch, ref } from 'vue';

const props = defineProps({
  branches: {
    type: Object,
    default: () => ({ list: [], current: '' })
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
  }
});

const emit = defineEmits(['update:source-branch', 'update:target-branches', 'clear-targets']);

const localSource = ref(props.sourceBranch);
const localTargets = ref([...props.targetBranches]);
const targetSearch = ref('');
const bulkInput = ref('');
const bulkFeedback = ref('');
const checkingRemote = ref(false);
let pasteAutoAddTimer = null;

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

const filteredTargets = computed(() => {
  const keyword = targetSearch.value.trim().toLowerCase();
  const base = branchList.value;

  if (!keyword) {
    // 大仓库分支很多时，默认只渲染已选 + 前 200 条，减少 DOM 压力避免卡顿
    const selectedSet = new Set(localTargets.value);
    const preview = [];
    for (const branch of base) {
      if (!selectedSet.has(branch)) {
        preview.push(branch);
      }
      if (preview.length >= 200) break;
    }
    return [...localTargets.value, ...preview];
  }

  const matched = base.filter((branch) => branch.toLowerCase().includes(keyword));
  const selected = localTargets.value.filter((branch) => !matched.includes(branch));
  return Array.from(new Set([...selected, ...matched]));
});

const sanitizeBranchName = (value = '') => {
  if (!value) return '';

  let v = value;

  // 去掉中英文括号中的备注
  v = v.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '');

  // 处理类似「we-camapg -3倍」「we-necklacepg 2倍」「we-conchapg 2倍」这类带倍数说明的文案
  // - 可选的前导空格和连接符（-、–、—）
  // - 阿拉伯数字或中文数字（支持 0-9 和 一二三四五六七八九十百千万）
  // - 结尾的「倍」字
  v = v.replace(/\s*[-–—]?\s*[0-9一二三四五六七八九十百千万]+倍\s*$/u, '');

  return v.trim();
};

const branchList = computed(() => props.branches?.list ?? props.branches?.branches ?? []);

const applyBulkInput = async () => {
  if (checkingRemote.value) return;
  const entries = bulkInput.value
    .split(/\r?\n/)
    .map((line) => sanitizeBranchName(line))
    .filter(Boolean);

  if (!entries.length) {
    bulkFeedback.value = '请输入有效的分支名称';
    return;
  }

  // 显示查询状态
  bulkFeedback.value = '正在查询远程分支...';
  checkingRemote.value = true;

  try {
    // 查询远程分支验证分支是否存在
    if (!window.electronAPI?.checkRemoteBranches) {
      bulkFeedback.value = '当前环境不支持远程分支查询';
      return;
    }

    const result = await window.electronAPI.checkRemoteBranches(entries, props.repoIndex);

    if (!result?.ok) {
      bulkFeedback.value = `查询失败：${result?.error || '未知错误'}`;
      return;
    }

    const { exists, notExists } = result.data || { exists: [], notExists: [] };

    // 只添加在远程存在的分支
    if (exists.length > 0) {
      const merged = Array.from(new Set([...localTargets.value, ...exists]));
      localTargets.value = merged;
      emitTargetBranches(merged);
    }

    // 生成反馈信息
    const parts = [];
    if (exists.length > 0) {
      parts.push(`已添加 ${exists.length} 个分支`);
    }
    if (notExists.length > 0) {
      parts.push(`未找到：${notExists.join('，')}`);
    }

    if (parts.length > 0) {
      bulkFeedback.value = parts.join('；');
    } else {
      bulkFeedback.value = '未添加任何分支';
    }
  } catch (error) {
    bulkFeedback.value = `查询远程分支失败：${error?.message || '未知错误'}`;
  } finally {
    checkingRemote.value = false;
  }
};

const handleBulkPaste = () => {
  // 粘贴场景下自动触发“添加到目标分支”，贴合“手动输入后自动添加”的使用习惯
  if (pasteAutoAddTimer) clearTimeout(pasteAutoAddTimer);
  pasteAutoAddTimer = setTimeout(() => {
    applyBulkInput();
  }, 120);
};

const clearTargets = () => {
  localTargets.value = [];
  emitTargetBranches([]);
  emit('clear-targets');
  bulkFeedback.value = '已清空所有目标分支';
};

const onSourceChange = () => {
  emit('update:source-branch', localSource.value);
  if (localTargets.value.includes(localSource.value)) {
    localTargets.value = localTargets.value.filter(
      (branch) => branch !== localSource.value
    );
    emitTargetBranches(localTargets.value);
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
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  min-height: 160px;
  max-height: 280px;
  padding: 12px;
  background: color-mix(in srgb, var(--surface-muted) 70%, transparent);
  border-radius: 14px;
  border: 1px dashed var(--border);
  overflow-y: auto;
  overflow-x: hidden;
  contain: content;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.target-list::-webkit-scrollbar {
  display: none;
}

.target-item {
  justify-content: flex-start;
  align-items: center;
  padding: 10px 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-muted) 85%, transparent);
  border: 1px solid transparent;
  transition: border 0.2s ease, background 0.2s ease;
}

.target-item:hover {
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-muted) 92%, var(--accent) 8%);
}

.target-item span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
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
