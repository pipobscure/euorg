<script lang="ts">
	import type { SyncProgress, SyncResult } from "../lib/types.ts";

	let {
		syncProgress = null,
		lastSyncResult = null,
		lastSyncTime = null,
		onSync,
	}: {
		syncProgress: SyncProgress | null;
		lastSyncResult: SyncResult | null;
		lastSyncTime: number | null;
		onSync: () => void;
	} = $props();

	const syncing = $derived(syncProgress !== null);

	function formatTime(ts: number | null): string {
		if (!ts) return "";
		const d = new Date(ts);
		return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	}
</script>

<div class="flex items-center gap-2 px-3 py-1.5 text-xs text-surface-600-400 select-none">
	{#if syncing}
		<span class="inline-block h-2 w-2 rounded-full bg-primary-500 animate-pulse"></span>
		<span class="truncate">{syncProgress!.phase}{syncProgress!.total > 0 ? ` (${syncProgress!.done}/${syncProgress!.total})` : ""}</span>
	{:else if lastSyncResult?.errors?.length}
		<span class="text-error-500">⚠ Sync error</span>
	{:else if lastSyncTime}
		<span>Synced {formatTime(lastSyncTime)}</span>
		{#if lastSyncResult && (lastSyncResult.added + lastSyncResult.updated + lastSyncResult.deleted) > 0}
			<span class="text-success-600">· {lastSyncResult.added + lastSyncResult.updated} changed</span>
		{/if}
	{/if}

	<button
		class="ml-auto btn-icon btn-icon-sm hover:preset-tonal-primary rounded"
		onclick={onSync}
		disabled={syncing}
		title="Sync now"
	>
		<svg class="w-3.5 h-3.5 {syncing ? 'animate-spin' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
			<path d="M1 4v6h6M23 20v-6h-6" />
			<path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15" />
		</svg>
	</button>
</div>
