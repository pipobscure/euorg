<script lang="ts">
	import type { Collection } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		collections: Collection[];
		defaultCollectionId: string | null;
		initialVcfText?: string | null;
		onClose: () => void;
	}

	let { collections, defaultCollectionId, initialVcfText = null, onClose }: Props = $props();

	let selectedCollectionId = $state(defaultCollectionId ?? collections[0]?.id ?? "");
	let vcfText = $state(initialVcfText ?? "");
	let fileName = $state(initialVcfText ? "Received file" : "");
	let importing = $state(false);
	let result = $state<{ imported: number; skipped: number; errors: string[] } | null>(null);

	function handleFileChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (!file) return;
		fileName = file.name;
		result = null;
		const reader = new FileReader();
		reader.onload = (ev) => {
			vcfText = (ev.target?.result as string) ?? "";
		};
		reader.readAsText(file);
	}

	async function handleImport() {
		if (!vcfText || !selectedCollectionId || importing) return;
		importing = true;
		result = null;
		try {
			result = await rpc.request.importVCards({ vcfText, collectionId: selectedCollectionId });
		} catch (e) {
			result = { imported: 0, skipped: 0, errors: [e instanceof Error ? e.message : String(e)] };
		} finally {
			importing = false;
		}
	}

	function handleClose() {
		if (importing) return;
		onClose();
	}
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
	role="dialog"
	aria-modal="true"
>
	<div class="bg-surface-50 dark:bg-surface-900 w-full max-w-md rounded-xl p-6 shadow-xl">
		<h2 class="mb-4 text-lg font-semibold">Import Contacts</h2>

		<div class="space-y-4">
			<!-- File picker -->
			<div>
				<label class="text-surface-400 mb-1 block text-xs font-medium">vCard file (.vcf)</label>
				<label
					class="border-surface-200-800 hover:border-primary-500 flex cursor-pointer items-center gap-3 rounded-lg border-2 border-dashed px-4 py-3 transition-colors"
				>
					<span class="text-surface-400 text-sm">📄</span>
					<span class="text-sm {fileName ? '' : 'text-surface-400'}">
						{fileName || "Choose a .vcf file…"}
					</span>
					<input
						class="hidden"
						type="file"
						accept=".vcf,text/vcard"
						onchange={handleFileChange}
					/>
				</label>
			</div>

			<!-- Collection selector -->
			{#if collections.length > 1}
				<div>
					<label class="text-surface-400 mb-1 block text-xs font-medium">Import into</label>
					<select class="select w-full" bind:value={selectedCollectionId}>
						{#each collections as col}
							<option value={col.id}>{col.name}</option>
						{/each}
					</select>
				</div>
			{:else if collections.length === 1}
				<p class="text-surface-400 text-sm">
					Will import into: <span class="font-medium">{collections[0].name}</span>
				</p>
			{/if}

			<!-- Result -->
			{#if result}
				<div class="rounded-lg p-3 {result.errors.length > 0 && result.imported === 0 ? 'bg-error-500/10' : 'bg-success-500/10'}">
					{#if result.imported > 0}
						<p class="text-success-600 dark:text-success-400 text-sm font-medium">
							✓ Imported {result.imported} contact{result.imported !== 1 ? "s" : ""}
						</p>
					{/if}
					{#if result.skipped > 0}
						<p class="text-surface-400 text-sm">
							{result.skipped} already present, skipped
						</p>
					{/if}
					{#if result.errors.length > 0}
						<p class="text-error-500 text-sm font-medium">
							{result.errors.length} error{result.errors.length !== 1 ? "s" : ""}:
						</p>
						<ul class="text-error-500 mt-1 space-y-1 text-xs">
							{#each result.errors.slice(0, 5) as err}
								<li class="truncate">• {err}</li>
							{/each}
							{#if result.errors.length > 5}
								<li class="text-surface-400">…and {result.errors.length - 5} more</li>
							{/if}
						</ul>
					{/if}
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="mt-6 flex gap-3">
			<button
				class="btn preset-outlined-surface-500 flex-1"
				onclick={handleClose}
				disabled={importing}
			>
				{result ? "Close" : "Cancel"}
			</button>
			{#if !result}
				<button
					class="btn preset-filled-primary-500 flex-1"
					onclick={handleImport}
					disabled={!vcfText || !selectedCollectionId || importing}
				>
					{importing ? "Importing…" : "Import"}
				</button>
			{/if}
		</div>
	</div>
</div>
