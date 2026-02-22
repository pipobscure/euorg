<script lang="ts">
	import type { SyncProgress, SyncResult } from "../lib/types.ts";

	interface Props {
		syncProgress: SyncProgress | null;
		syncResult: SyncResult | null;
		isSyncing: boolean;
	}

	let { syncProgress, syncResult, isSyncing }: Props = $props();

	const statusText = $derived.by(() => {
		if (isSyncing && syncProgress) {
			const { phase, done, total, calendarName, eventsDone, eventsTotal } = syncProgress;
			if (phase === "syncing" && calendarName) {
				if (eventsTotal != null && eventsDone != null) {
					return `Syncing ${calendarName}… ${eventsDone}/${eventsTotal} events`;
				}
				return `Syncing ${calendarName}… (${done + 1}/${total})`;
			}
			return `Syncing… (${done}/${total})`;
		}
		if (syncResult) {
			const { added, updated, deleted, errors } = syncResult;
			if (errors.length > 0) return `Sync done — ${errors.length} error(s)`;
			return `Sync done · +${added} ~${updated} −${deleted}`;
		}
		return "";
	});
</script>

{#if statusText}
	<div class="flex items-center gap-2 border-t border-surface-200-800 px-4 py-1 text-xs text-surface-500-400 bg-surface-50-950 shrink-0">
		{#if isSyncing}
			<svg class="size-3 animate-spin text-primary-500" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/>
			</svg>
		{/if}
		<span>{statusText}</span>
	</div>
{/if}
