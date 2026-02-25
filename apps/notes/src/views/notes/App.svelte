<script lang="ts">
	import { onMount } from "svelte";
	import AppShell from "@euorg/shared/ui/AppShell.svelte";
	import { rpc } from "./lib/rpc.ts";
	import type { NoteRow, Account, SyncProgress, SyncResult } from "./lib/types.ts";
	import NoteList from "./components/NoteList.svelte";
	import NoteEditor from "./components/NoteEditor.svelte";
	import AccountSettings from "./components/AccountSettings.svelte";
	import SyncStatus from "./components/SyncStatus.svelte";

	// ── State ──────────────────────────────────────────────────────────────────
	let notes = $state<NoteRow[]>([]);
	let selectedUid = $state<string | null>(null);
	let selectedNote = $derived(notes.find((n) => n.uid === selectedUid) ?? null);

	let accounts = $state<Account[]>([]);
	let showAccountSettings = $state(false);

	let searchQuery = $state("");
	let syncProgress = $state<SyncProgress | null>(null);
	let lastSyncResult = $state<SyncResult | null>(null);
	let lastSyncTime = $state<number | null>(null);

	let defaultAccountId = $derived(accounts.find((a) => a.enabled)?.id ?? null);

	// ── Tags ───────────────────────────────────────────────────────────────────
	let selectedTag = $state<string | null>(null);

	// All unique tags across all notes, sorted
	let allTags = $derived(
		Array.from(new Set(notes.flatMap((n) => n.tags))).sort()
	);

	// Notes filtered by active tag (search is already applied server-side)
	let filteredNotes = $derived(
		selectedTag ? notes.filter((n) => n.tags.includes(selectedTag!)) : notes
	);

	// ── Load ───────────────────────────────────────────────────────────────────
	async function loadNotes() {
		if (searchQuery.trim()) {
			notes = await rpc.request.searchNotes({ query: searchQuery });
		} else {
			notes = await rpc.request.getNotes();
		}
	}

	async function loadAccounts() {
		accounts = await rpc.request.getAccounts();
	}

	onMount(async () => {
		await Promise.all([loadNotes(), loadAccounts()]);

		rpc.addMessageListener("syncProgress", (p) => {
			syncProgress = p;
		});

		rpc.addMessageListener("syncComplete", (r) => {
			syncProgress = null;
			lastSyncResult = r;
			lastSyncTime = Date.now();
			loadNotes();
		});

		rpc.addMessageListener("noteChanged", async ({ uid, action }) => {
			if (action === "deleted" && selectedUid === uid) {
				selectedUid = null;
			}
			// "updated" is already handled locally by handleSave/handleTitleChange
			if (action !== "updated") {
				await loadNotes();
			}
		});
	});

	// ── Actions ────────────────────────────────────────────────────────────────
	async function createNote() {
		if (!defaultAccountId) {
			showAccountSettings = true;
			return;
		}
		const note = await rpc.request.createNote({
			subject: "",
			bodyHtml: "",
			accountId: defaultAccountId,
		});
		if (note) {
			await loadNotes();
			selectedUid = note.uid;
		}
	}

	async function handleSave(uid: string, bodyHtml: string) {
		const updated = await rpc.request.updateNote({ uid, bodyHtml });
		if (updated) {
			notes = notes.map((n) => (n.uid === uid ? updated : n));
		}
	}

	async function handleTitleChange(uid: string, subject: string) {
		const updated = await rpc.request.updateNote({ uid, subject });
		if (updated) {
			notes = notes.map((n) => (n.uid === uid ? updated : n));
		}
	}

	async function handleDelete(uid: string) {
		await rpc.request.deleteNote({ uid });
		notes = notes.filter((n) => n.uid !== uid);
		if (selectedUid === uid) selectedUid = null;
	}

	async function handleTagsChange(uid: string, tags: string[]) {
		const updated = await rpc.request.setNoteTags({ uid, tags });
		if (updated) {
			notes = notes.map((n) => (n.uid === uid ? updated : n));
		}
	}

	async function handleSearch(q: string) {
		searchQuery = q;
		await loadNotes();
	}

	function triggerSync() {
		rpc.request.triggerSync();
	}

	// Keyboard shortcuts
	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === "n") {
			e.preventDefault();
			createNote();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<AppShell>
	{#snippet header()}
		<div class="flex items-center gap-2 px-4 py-2 h-full">
			<h1 class="text-sm font-semibold">Notes</h1>
			<div class="flex-1"></div>
			<button
				class="btn-icon btn-icon-sm hover:preset-tonal rounded"
				onclick={() => showAccountSettings = !showAccountSettings}
				title="Account settings"
			>
				<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="3"/>
					<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
				</svg>
			</button>
		</div>
	{/snippet}

	<div class="flex h-full overflow-hidden">
		{#if showAccountSettings}
			<!-- Account settings panel -->
			<div class="w-80 shrink-0 border-r border-surface-200-800 flex flex-col">
				<AccountSettings
					{accounts}
					onClose={() => showAccountSettings = false}
					onAccountsChanged={async () => { await loadAccounts(); await loadNotes(); }}
				/>
			</div>
		{:else}
			<!-- Note list panel -->
			<div class="w-72 shrink-0 border-r border-surface-200-800 flex flex-col">
				<!-- Tag filter strip (only when tags exist) -->
				{#if allTags.length > 0}
					<div class="px-3 py-1.5 border-b border-surface-100-900 flex flex-wrap gap-1">
						<button
							class="px-2 py-0.5 text-xs rounded-full transition-colors {!selectedTag ? 'bg-primary-500 text-white' : 'bg-surface-200-800 hover:bg-surface-300-700'}"
							onclick={() => selectedTag = null}
						>All</button>
						{#each allTags as tag}
							<button
								class="px-2 py-0.5 text-xs rounded-full transition-colors {selectedTag === tag ? 'bg-primary-500 text-white' : 'bg-surface-200-800 hover:bg-surface-300-700'}"
								onclick={() => selectedTag = selectedTag === tag ? null : tag}
							>{tag}</button>
						{/each}
					</div>
				{/if}
				<div class="flex-1 overflow-hidden">
					<NoteList
						notes={filteredNotes}
						{selectedUid}
						{searchQuery}
						onSelect={(uid) => selectedUid = uid}
						onNew={createNote}
						onSearchChange={handleSearch}
					/>
				</div>
				<div class="border-t border-surface-200-800">
					<SyncStatus
						{syncProgress}
						{lastSyncResult}
						{lastSyncTime}
						onSync={triggerSync}
					/>
				</div>
			</div>
		{/if}

		<!-- Editor panel -->
		<div class="flex-1 overflow-hidden flex flex-col">
			<NoteEditor
				note={selectedNote}
				onSave={handleSave}
				onTitleChange={handleTitleChange}
				onDelete={handleDelete}
				onTagsChange={handleTagsChange}
			/>
		</div>
	</div>
</AppShell>
