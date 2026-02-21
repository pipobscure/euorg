<script lang="ts">
	import type { ContactRow } from "../lib/types.ts";

	interface DuplicatePair {
		primaryUid: string;
		secondaryUid: string;
	}

	interface Props {
		pairs: DuplicatePair[];
		contacts: ContactRow[];
		currentIdx: number;
		onSkip: () => void;
		onMerge: (primaryUid: string, secondaryUid: string) => void;
		onClose: () => void;
	}

	let { pairs, contacts, currentIdx, onSkip, onMerge, onClose }: Props = $props();

	let pair = $derived(pairs[currentIdx] ?? null);
	let primaryRow = $derived(pair ? (contacts.find((c) => c.uid === pair.primaryUid) ?? null) : null);
	let secondaryRow = $derived(pair ? (contacts.find((c) => c.uid === pair.secondaryUid) ?? null) : null);

	function fmtEmails(row: ContactRow | null): string {
		if (!row?.emails.length) return "—";
		return row.emails.map((e) => e.value).join(", ");
	}

	function fmtPhones(row: ContactRow | null): string {
		if (!row?.phones.length) return "—";
		return row.phones.map((p) => p.value).join(", ");
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	role="dialog"
	aria-modal="true"
>
	<div class="bg-surface-50 dark:bg-surface-900 w-full max-w-2xl rounded-xl p-6 shadow-xl">
		<!-- Header -->
		<div class="mb-1 flex items-center justify-between">
			<h2 class="text-lg font-semibold">Duplicate Contacts</h2>
			<span class="text-surface-400 text-sm">{currentIdx + 1} of {pairs.length}</span>
		</div>
		<p class="text-surface-400 mb-4 text-sm">
			Review each pair and choose to merge or skip. Merging opens the combined contact in the editor — only saved changes are applied.
		</p>

		{#if pair && primaryRow && secondaryRow}
			<div class="grid grid-cols-2 gap-4">
				<!-- Primary (kept) -->
				<div class="bg-surface-100 dark:bg-surface-800 rounded-lg p-4">
					<div class="text-surface-400 mb-2 text-xs font-medium uppercase tracking-wide">Keep (primary)</div>
					<p class="font-semibold">{primaryRow.displayName}</p>
					<p class="text-surface-500 mt-1 text-sm">{fmtEmails(primaryRow)}</p>
					<p class="text-surface-500 text-sm">{fmtPhones(primaryRow)}</p>
					{#if primaryRow.org}
						<p class="text-surface-400 text-sm">{primaryRow.org}</p>
					{/if}
				</div>

				<!-- Secondary (merged in + deleted) -->
				<div class="bg-surface-100 dark:bg-surface-800 rounded-lg p-4">
					<div class="text-surface-400 mb-2 text-xs font-medium uppercase tracking-wide">Merge &amp; delete</div>
					<p class="font-semibold">{secondaryRow.displayName}</p>
					<p class="text-surface-500 mt-1 text-sm">{fmtEmails(secondaryRow)}</p>
					<p class="text-surface-500 text-sm">{fmtPhones(secondaryRow)}</p>
					{#if secondaryRow.org}
						<p class="text-surface-400 text-sm">{secondaryRow.org}</p>
					{/if}
				</div>
			</div>
		{:else}
			<p class="text-surface-400 text-sm italic">Contact data not available for this pair.</p>
		{/if}

		<!-- Actions -->
		<div class="mt-6 flex gap-3">
			<button class="btn preset-outlined-surface-500" onclick={onClose}>Done</button>
			<div class="flex-1"></div>
			<button
				class="btn preset-outlined-surface-500"
				onclick={onSkip}
				disabled={!pair}
			>
				Skip
			</button>
			<button
				class="btn preset-filled-primary-500"
				onclick={() => pair && onMerge(pair.primaryUid, pair.secondaryUid)}
				disabled={!pair || !primaryRow || !secondaryRow}
			>
				Merge &amp; Edit
			</button>
		</div>
	</div>
</div>
