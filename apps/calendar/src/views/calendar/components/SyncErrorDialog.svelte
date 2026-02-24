<script lang="ts">
	import { rpc } from "../lib/rpc.ts";
	import type { SyncError } from "../lib/types.ts";

	interface Props {
		errors: SyncError[];
		onClose: () => void;
	}

	let { errors, onClose }: Props = $props();

	let idx = $state(0);
	let shouldIgnore = $state(false);
	let busy = $state(false);

	const current = $derived(errors[idx] ?? null);
	const remaining = $derived(errors.length - idx);

	async function handleDelete() {
		if (!current || busy) return;
		busy = true;
		try {
			await rpc.request.acknowledgeSyncError({
				href: current.href,
				shouldDelete: true,
				shouldIgnore: false,
				accountId: current.accountId,
			});
		} catch {
			// best effort
		}
		advance();
	}

	async function handleSkip() {
		if (!current || busy) return;
		busy = true;
		if (shouldIgnore) {
			try {
				await rpc.request.acknowledgeSyncError({
					href: current.href,
					shouldDelete: false,
					shouldIgnore: true,
					accountId: current.accountId,
				});
			} catch {
				// best effort
			}
		}
		advance();
	}

	function advance() {
		busy = false;
		shouldIgnore = false;
		if (idx + 1 >= errors.length) {
			onClose();
		} else {
			idx++;
		}
	}
</script>

<svelte:window onkeydown={(e) => {
	if (e.key === "Escape") { e.stopPropagation(); onClose(); }
	else if (e.key === "Delete" || e.key === "d") { e.preventDefault(); handleDelete(); }
	else if (e.key === "s" || e.key === "Enter") { e.preventDefault(); handleSkip(); }
}} />

{#if current}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div class="bg-surface-50 dark:bg-surface-900 border border-surface-200-800 rounded-xl shadow-xl w-[480px] max-w-[95vw] flex flex-col gap-0 overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between px-5 pt-5 pb-3">
				<div class="flex items-center gap-2">
					<span class="text-error-500 text-lg">⚠</span>
					<h2 class="text-surface-900-100 font-semibold text-sm">Sync Error</h2>
				</div>
				{#if errors.length > 1}
					<span class="text-surface-400 text-xs">{idx + 1} of {errors.length}</span>
				{/if}
			</div>

			<!-- Body -->
			<div class="px-5 pb-4 flex flex-col gap-3">
				<!-- Event summary -->
				<div class="bg-surface-100 dark:bg-surface-800 rounded-lg px-4 py-3">
					<p class="text-surface-900-100 font-medium text-sm truncate">
						{current.summary ?? "(unknown event)"}
					</p>
					<p class="text-surface-400 text-xs mt-0.5 break-all">{current.href}</p>
				</div>

				<!-- Error message -->
				<div class="bg-error-50 dark:bg-error-950/30 border border-error-200 dark:border-error-800 rounded-lg px-4 py-3">
					<p class="text-error-700 dark:text-error-300 text-xs font-mono break-words">{current.message}</p>
				</div>

				<p class="text-surface-500-400 text-xs">
					This event could not be processed during sync. You can delete it from the server, or skip it.
				</p>

				<!-- Remember checkbox (only shown on Skip path) -->
				<label class="flex items-center gap-2 cursor-pointer select-none">
					<input
						type="checkbox"
						class="checkbox"
						bind:checked={shouldIgnore}
					/>
					<span class="text-surface-600-400 text-sm">Don't ask again for this event</span>
				</label>
			</div>

			<!-- Actions -->
			<div class="flex gap-2 justify-end px-5 pb-5">
				<button
					class="btn preset-tonal text-sm"
					onclick={handleSkip}
					disabled={busy}
				>Skip</button>
				<button
					class="btn preset-filled-error-500 text-sm"
					onclick={handleDelete}
					disabled={busy}
				>Delete from server</button>
			</div>
		</div>
	</div>
{/if}
