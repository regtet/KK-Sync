<template>
    <div class="log-view">
        <header>
            <h2>日志输出</h2>
            <div class="header-actions">
                <button v-if="logs.length" class="icon-btn" title="清空日志" @click="emit('clear')"> 清空 </button>
                <div class="status-pill" :class="syncing ? 'active' : ''">
                    <span class="dot" :class="syncing ? 'running' : 'idle'"></span>
                    {{ statusLabel }}
                </div>
            </div>
        </header>
        <div ref="scrollRef" class="log-scroll scroll-thin">
            <ul>
                <li v-for="(log, index) in logs" :key="index" :class="log.level">
                    <span class="timestamp">{{ formatTime(log.timestamp) }}</span>
                    <span class="message">{{ log.message }}</span>
                </li>
            </ul>
        </div>
    </div>
</template>
<script setup>
import { computed, onUpdated, onMounted, onBeforeUnmount, ref } from 'vue';

const emit = defineEmits(['clear']);

const props = defineProps({
    logs: {
        type: Array,
        default: () => []
    },
    syncing: {
        type: Boolean,
        default: false
    },
    syncProgress: {
        type: Object,
        default: null
    }
});

const statusLabel = computed(() => {
    if (!props.syncing) return '等待中';
    const progress = props.syncProgress;
    if (!progress?.total) return '执行中';
    const current = Math.min(progress.current || 0, progress.total);
    const branch = progress.branch ? ` · ${progress.branch}` : '';
    return `执行中 ${current}/${progress.total}${branch}`;
});

const scrollRef = ref(null);
const isUserAtBottom = ref(true);
const scrollThreshold = 50; // 距离底部50px内认为是在底部

const formatTime = (timestamp) => {
    if (!timestamp) return '';
    try {
        return new Date(timestamp).toLocaleTimeString();
    } catch {
        return '';
    }
};

const checkIfAtBottom = () => {
    const el = scrollRef.value;
    if (!el) return;
    
    const { scrollTop, scrollHeight, clientHeight } = el;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isUserAtBottom.value = distanceFromBottom <= scrollThreshold;
};

const handleScroll = () => {
    checkIfAtBottom();
};

onMounted(() => {
    const el = scrollRef.value;
    if (el) {
        el.addEventListener('scroll', handleScroll);
        // 初始状态认为在底部
        isUserAtBottom.value = true;
    }
});

onBeforeUnmount(() => {
    const el = scrollRef.value;
    if (el) {
        el.removeEventListener('scroll', handleScroll);
    }
});

onUpdated(() => {
    const el = scrollRef.value;
    if (el && isUserAtBottom.value) {
        // 只有当用户在底部时才自动滚动
        el.scrollTop = el.scrollHeight;
    }
});
</script>
<style scoped>
.log-view {
    display: flex;
    flex-direction: column;
    gap: 16px;
    height: 100%;
    min-height: 0;
}

header {
    display: flex;
    align-items: center;
    justify-content: space-between;
}

header h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: 0.4px;
}

.header-actions {
    display: inline-flex;
    align-items: center;
    gap: 12px;
}

.icon-btn {
    padding: 6px 12px;
    border-radius: 10px;
    border: 1px solid rgba(148, 163, 184, 0.25);
    background: rgba(30, 41, 59, 0.45);
    color: rgba(226, 232, 240, 0.85);
    font-size: 12px;
    letter-spacing: 0.3px;
    transition: border 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.icon-btn:hover {
    border-color: rgba(148, 163, 184, 0.6);
    background: rgba(59, 130, 246, 0.25);
    color: #e2e8f0;
}

.status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--surface-muted) 65%, transparent);
    color: var(--text-muted);
    font-size: 13px;
    transition: background 0.2s ease;
}

.status-pill.active {
    background: color-mix(in srgb, var(--accent) 25%, transparent);
    color: var(--text);
}

.status-pill .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-strong);
}

.status-pill .dot.running {
    background: var(--accent);
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 55%, transparent);
}

.status-pill .dot.idle {
    background: var(--border-strong);
}

.log-scroll {
    flex: 1;
    border-radius: 14px;
    background: color-mix(in srgb, var(--surface) 85%, transparent);
    box-shadow: inset 0 0 0 1px var(--border);
    padding: 16px;
    overflow-y: auto;
}

ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
}

li {
    display: flex;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-muted) 80%, transparent);
    box-shadow: 0 8px 18px rgba(0, 0, 0, 0.28);
}

.timestamp {
    color: var(--text-muted);
    min-width: 72px;
    font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
}

.message {
    flex: 1;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
}

li.warn {
    background: color-mix(in srgb, var(--warning) 20%, var(--surface) 80%);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--warning) 25%, transparent);
}

li.warn .message {
    color: var(--warning);
}

li.error {
    background: color-mix(in srgb, var(--danger) 22%, var(--surface) 78%);
    box-shadow: 0 8px 18px color-mix(in srgb, var(--danger) 28%, transparent);
}

li.error .message {
    color: var(--danger);
}
</style>
