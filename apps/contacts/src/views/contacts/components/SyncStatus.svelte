<script lang="ts">
	import type { SyncProgress, SyncResult } from "../lib/types.ts";

	interface Props {
		progress: SyncProgress | null;
		lastResult: SyncResult | null;
		lastSyncTime: number | null;
		contactCount: number;
	}

	let { progress, lastResult, lastSyncTime, contactCount }: Props = $props();

	function timeAgo(ts: number): string {
		const secs = Math.floor((Date.now() - ts) / 1000);
		if (secs < 10) return "just now";
		if (secs < 60) return `${secs}s ago`;
		if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
		return `${Math.floor(secs / 3600)}h ago`;
	}
</script>

<div class="border-surface-200-800 text-surface-400 flex h-7 items-center gap-3 border-t px-4 text-xs">
	{#if progress && progress.phase !== "done"}
		<!-- Syncing in progress -->
		<span class="text-primary-500 animate-pulse">●</span>
		<span>
			Syncing {progress.collectionName ?? ""}…
			{#if progress.total > 0}
				{progress.done}/{progress.total}
			{/if}
		</span>
	{:else}
		<!-- Idle -->
		<span class="text-success-500">●</span>
		<span>
			{contactCount} contact{contactCount === 1 ? "" : "s"}
		</span>
		{#if lastSyncTime}
			<span>· Synced {timeAgo(lastSyncTime)}</span>
		{/if}
		{#if lastResult && lastResult.errors.length > 0}
			<span class="text-warning-500">· {lastResult.errors.length} error{lastResult.errors.length === 1 ? "" : "s"}</span>
		{/if}
	{/if}
</div>
