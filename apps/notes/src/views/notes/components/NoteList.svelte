<script lang="ts">
	import type { NoteRow } from "../lib/types.ts";

	let {
		notes,
		selectedUid = null,
		searchQuery = "",
		onSelect,
		onNew,
		onSearchChange,
	}: {
		notes: NoteRow[];
		selectedUid: string | null;
		searchQuery: string;
		onSelect: (uid: string) => void;
		onNew: () => void;
		onSearchChange: (q: string) => void;
	} = $props();

	function formatDate(iso: string): string {
		const d = new Date(iso);
		const now = new Date();
		const diff = now.getTime() - d.getTime();
		if (diff < 86400000 && d.getDate() === now.getDate()) {
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}
		if (diff < 7 * 86400000) {
			return d.toLocaleDateString([], { weekday: "short" });
		}
		return d.toLocaleDateString([], { month: "short", day: "numeric" });
	}

	function stripHtml(html: string): string {
		return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
	}

	let searchInput = $state<HTMLInputElement | undefined>();

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === "f") {
			e.preventDefault();
			searchInput?.focus();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col h-full">
	<!-- Search + New -->
	<div class="flex items-center gap-2 px-3 py-2 border-b border-surface-200-800">
		<div class="relative flex-1">
			<svg class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-surface-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
			</svg>
			<input
				bind:this={searchInput}
				class="input input-sm pl-7 w-full text-sm"
				placeholder="Search notes…"
				value={searchQuery}
				oninput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
			/>
		</div>
		<button
			class="btn-icon btn-icon-sm preset-filled-primary rounded"
			onclick={onNew}
			title="New note (Ctrl+N)"
		>
			<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
				<path d="M12 5v14M5 12h14"/>
			</svg>
		</button>
	</div>

	<!-- Note list -->
	<div class="flex-1 overflow-y-auto">
		{#if notes.length === 0}
			<div class="text-center text-sm text-surface-500 py-12 px-4">
				{searchQuery ? "No matching notes." : "No notes yet. Click + to create one."}
			</div>
		{:else}
			{#each notes as note (note.uid)}
				<button
					class="w-full text-left px-4 py-3 border-b border-surface-100-900 hover:bg-surface-100-900 transition-colors
					       {note.uid === selectedUid ? 'bg-primary-50-950 border-l-2 border-l-primary-500' : ''}"
					onclick={() => onSelect(note.uid)}
				>
					<div class="flex items-start justify-between gap-2 min-w-0">
						<span class="font-medium text-sm truncate flex-1">
							{note.subject || "Untitled"}
						</span>
						<span class="text-xs text-surface-500 shrink-0 mt-0.5">{formatDate(note.modifiedAt)}</span>
					</div>
					<div class="text-xs text-surface-500 mt-0.5 truncate">
						{stripHtml(note.bodyHtml) || "No content"}
					</div>
					{#if note.pendingSync}
						<span class="inline-block mt-1 w-1.5 h-1.5 rounded-full bg-warning-500" title="Pending sync"></span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>
</div>
