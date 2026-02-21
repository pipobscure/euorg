<script lang="ts">
	import { onMount } from "svelte";
	import { rpc } from "./lib/rpc.ts";
	import type { ContactRow, VCard, Account, Collection, SyncProgress, SyncResult } from "./lib/types.ts";
	import ContactList from "./components/ContactList.svelte";
	import ContactDetail from "./components/ContactDetail.svelte";
	import ContactEditor from "./components/ContactEditor.svelte";
	import AccountSettings from "./components/AccountSettings.svelte";
	import SyncStatus from "./components/SyncStatus.svelte";
	import ContextMenu, { type MenuItem } from "./components/ContextMenu.svelte";
	import ImportPanel from "./components/ImportPanel.svelte";
	import DuplicatePanel from "./components/DuplicatePanel.svelte";

	// ── State ──────────────────────────────────────────────────────────────────
	let contacts = $state<ContactRow[]>([]);
	let selectedUid = $state<string | null>(null);
	let detailCard = $state<VCard | null>(null);

	let showEditor = $state(false);
	let showAccountSettings = $state(false);
	let showImport = $state(false);
	let importInitialVcf = $state<string | null>(null);
	let showDuplicatePanel = $state(false);

	// Deduplication state
	let duplicatePairs = $state<{ primaryUid: string; secondaryUid: string }[]>([]);
	let duplicatePairIdx = $state(0);
	let pendingMergeSecondaryUid = $state<string | null>(null);

	let accounts = $state<Account[]>([]);
	let enabledCollections = $state<Collection[]>([]);
	let defaultCollectionId = $state<string | null>(null);

	let syncProgress = $state<SyncProgress | null>(null);
	let lastSyncResult = $state<SyncResult | null>(null);
	let lastSyncTime = $state<number | null>(null);
	let contactCount = $state(0);

	// Brief notification banner (auto-clears)
	let notification = $state<string | null>(null);
	let notificationTimer: ReturnType<typeof setTimeout> | null = null;

	function showNotification(msg: string) {
		if (notificationTimer) clearTimeout(notificationTimer);
		notification = msg;
		notificationTimer = setTimeout(() => (notification = null), 4000);
	}

	// Context menu
	let contextMenu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);

	// Derived: ContactRow for the currently selected contact
	let selectedRow = $derived(contacts.find((c) => c.uid === selectedUid) ?? null);

	// ── Load ───────────────────────────────────────────────────────────────────
	async function loadContacts() {
		const rows = await rpc.request.getContacts();
		contacts = rows ?? [];
		contactCount = contacts.length;
	}

	async function loadAccounts() {
		const accs = await rpc.request.getAccounts();
		accounts = accs ?? [];
		const cols = await rpc.request.getEnabledCollections();
		enabledCollections = cols ?? [];
		if (accounts.length > 0 && accounts[0].defaultCollectionId) {
			defaultCollectionId = accounts[0].defaultCollectionId;
		} else if (enabledCollections.length > 0) {
			defaultCollectionId = enabledCollections[0].id;
		}
	}

	async function selectContact(uid: string) {
		selectedUid = uid;
		detailCard = null;
		const vcf = await rpc.request.getContactVcard({ uid });
		if (vcf) {
			detailCard = await rpc.request.parseVCardText({ vcf });
		}
	}

	// ── Search ─────────────────────────────────────────────────────────────────
	let lastSearchQuery = $state("");

	async function handleSearch(query: string) {
		lastSearchQuery = query;
		if (query.trim()) {
			const rows = await rpc.request.searchContacts({ query });
			contacts = rows ?? [];
		} else {
			await loadContacts();
		}
	}

	// Refresh respecting any active search filter
	async function refreshContacts() {
		await handleSearch(lastSearchQuery);
	}

	// ── Editor ─────────────────────────────────────────────────────────────────
	async function openEditorForUid(uid: string) {
		if (uid !== selectedUid || !detailCard) {
			await selectContact(uid);
		}
		showEditor = true;
	}

	async function handleEditorSave(uid: string) {
		showEditor = false;
		if (pendingMergeSecondaryUid) {
			// Delete the secondary contact now that the primary was saved
			await rpc.request.deleteContact({ uid: pendingMergeSecondaryUid });
			// Remove the processed pair from the list
			duplicatePairs = duplicatePairs.filter(
				(p) => !(p.primaryUid === uid || p.secondaryUid === pendingMergeSecondaryUid),
			);
			pendingMergeSecondaryUid = null;
			// Re-show the panel if more pairs remain
			if (duplicatePairs.length > 0) {
				if (duplicatePairIdx >= duplicatePairs.length) duplicatePairIdx = duplicatePairs.length - 1;
				showDuplicatePanel = true;
			}
		}
		await refreshContacts();
		if (uid) await selectContact(uid);
	}

	function handleEditorCancel() {
		showEditor = false;
		if (pendingMergeSecondaryUid) {
			// Merge was cancelled — go back to the duplicate panel without advancing
			pendingMergeSecondaryUid = null;
			showDuplicatePanel = true;
		}
	}

	// ── Delete ─────────────────────────────────────────────────────────────────
	async function deleteContactByUid(uid: string) {
		await rpc.request.deleteContact({ uid });
		if (selectedUid === uid) {
			selectedUid = null;
			detailCard = null;
		}
		await refreshContacts();
	}

	// ── Keyboard shortcuts ────────────────────────────────────────────────────
	function handleKeydown(e: KeyboardEvent) {
		if (!e.ctrlKey) return;
		// Do not fire when a modal is open or focus is in a text field
		if (showEditor || showAccountSettings || showImport || showDuplicatePanel) return;
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === "n") { e.preventDefault(); openNewContact(); }
		if (e.key === "e" && selectedUid) { e.preventDefault(); openEditorForUid(selectedUid); }
	}

	// ── Sync ───────────────────────────────────────────────────────────────────
	function triggerSync() {
		rpc.request.triggerSync();
	}

	// ── Export ─────────────────────────────────────────────────────────────────
	async function exportContact(uid: string) {
		try {
			const { path } = await rpc.request.exportContact({ uid });
			showNotification(`Saved to ${path}`);
		} catch (e) {
			showNotification(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async function exportCollection(collectionId: string) {
		try {
			const { path, count } = await rpc.request.exportCollection({ collectionId });
			showNotification(`Exported ${count} contacts to ${path}`);
		} catch (e) {
			showNotification(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── Deduplication ──────────────────────────────────────────────────────────
	async function openDuplicatePanel() {
		const pairs = await rpc.request.findDuplicates();
		duplicatePairs = pairs ?? [];
		duplicatePairIdx = 0;
		if (duplicatePairs.length > 0) {
			showDuplicatePanel = true;
		} else {
			showNotification("No duplicate contacts found.");
		}
	}

	function handleDuplicateSkip() {
		duplicatePairIdx++;
		if (duplicatePairIdx >= duplicatePairs.length) {
			showDuplicatePanel = false;
		}
	}

	async function handleDuplicateMerge(primaryUid: string, secondaryUid: string) {
		try {
			const { vcf } = await rpc.request.mergeContacts({ primaryUid, secondaryUid });
			const mergedCard = await rpc.request.parseVCardText({ vcf });
			pendingMergeSecondaryUid = secondaryUid;
			showDuplicatePanel = false;
			// Open editor pre-filled with the merged contact (will update primary's UID)
			detailCard = mergedCard;
			selectedUid = primaryUid;
			showEditor = true;
		} catch (e) {
			showNotification(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// ── Context menus ──────────────────────────────────────────────────────────
	function closeContextMenu() {
		contextMenu = null;
	}

	function buildExportCollectionSubmenu(): MenuItem[] {
		return enabledCollections.map((col) => {
			const acct = accounts.find((a) => a.id === col.accountId);
			const label = accounts.length > 1 ? `${col.name} — ${acct?.name ?? col.accountId}` : col.name;
			return { label, action: () => exportCollection(col.id) };
		});
	}

	function showContactMenu(uid: string, x: number, y: number) {
		const exportColSubmenu = buildExportCollectionSubmenu();
		const items: MenuItem[] = [
			{ label: "Edit", action: () => openEditorForUid(uid) },
			{ label: "Export contact", action: () => exportContact(uid) },
			{ separator: true },
			{ label: "New Contact", action: openNewContact },
			{ label: "Import contacts…", action: () => (showImport = true) },
			...(exportColSubmenu.length > 0 ? [{ label: "Export collection…", submenu: exportColSubmenu } as MenuItem] : []),
			{ separator: true },
			{ label: "Sync", action: triggerSync },
			{ label: "Find Duplicates…", action: openDuplicatePanel },
			{ label: "Account Settings", action: () => (showAccountSettings = true) },
			{ separator: true },
			{ label: "Delete", danger: true, action: () => deleteContactByUid(uid) },
		];
		contextMenu = { x, y, items };
	}

	function showAppMenu(x: number, y: number) {
		const exportColSubmenu = buildExportCollectionSubmenu();
		contextMenu = {
			x,
			y,
			items: [
				{ label: "New Contact", action: openNewContact },
				{ label: "Import contacts…", action: () => (showImport = true) },
				...(exportColSubmenu.length > 0 ? [{ label: "Export collection…", submenu: exportColSubmenu } as MenuItem] : []),
				{ separator: true },
				{ label: "Sync", action: triggerSync },
				{ label: "Find Duplicates…", action: openDuplicatePanel },
				{ label: "Account Settings", action: () => (showAccountSettings = true) },
			],
		};
	}

	function openNewContact() {
		showEditor = true;
	}

	// ── RPC message listeners ──────────────────────────────────────────────────
	rpc.addMessageListener("syncProgress", (payload: SyncProgress) => {
		syncProgress = payload;
	});

	rpc.addMessageListener("syncComplete", async (payload: SyncResult) => {
		syncProgress = null;
		lastSyncResult = payload;
		lastSyncTime = Date.now();
		await refreshContacts();
		if (selectedUid) {
			const row = contacts.find((c) => c.uid === selectedUid);
			if (row) await selectContact(selectedUid);
		}
	});

	rpc.addMessageListener("contactChanged", async (payload: { uid: string; action: string }) => {
		await refreshContacts();
		if (payload.action === "deleted" && selectedUid === payload.uid) {
			selectedUid = null;
			detailCard = null;
		} else if (payload.action !== "deleted") {
			await selectContact(payload.uid);
		}
	});

	rpc.addMessageListener("openImport", ({ vcfText }: { vcfText: string }) => {
		importInitialVcf = vcfText;
		showImport = true;
	});

	// ── Mount ──────────────────────────────────────────────────────────────────
	onMount(async () => {
		await loadAccounts();
		await loadContacts();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex h-screen flex-col overflow-hidden bg-surface-50 dark:bg-surface-950">
	<!-- Main content: list + detail (no toolbar) -->
	<div class="flex flex-1 overflow-hidden">
		<!-- Contact list pane (includes search) -->
		<div class="border-surface-200-800 w-64 shrink-0 border-r overflow-hidden">
			<ContactList
				{contacts}
				{selectedUid}
				onselect={selectContact}
				onsearch={handleSearch}
				onContactContextMenu={showContactMenu}
				onListContextMenu={showAppMenu}
			/>
		</div>

		<!-- Detail pane -->
		<div class="flex-1 overflow-hidden">
			{#if detailCard && selectedRow}
				<ContactDetail
					card={detailCard}
					row={selectedRow}
					{accounts}
					collections={enabledCollections}
					onMenu={(x, y) => showContactMenu(selectedUid!, x, y)}
				/>
			{:else if selectedUid}
				<div class="text-surface-400 flex h-full items-center justify-center text-sm">
					Loading…
				</div>
			{:else if contacts.length === 0 && accounts.length === 0}
				<div class="flex h-full flex-col items-center justify-center gap-3 text-center">
					<p class="text-surface-400 text-sm">No accounts configured yet.</p>
					<button
						class="btn preset-filled-primary-500 text-sm"
						onclick={() => (showAccountSettings = true)}
					>
						Add CardDAV Account
					</button>
				</div>
			{:else}
				<div
					class="text-surface-400 flex h-full items-center justify-center text-sm select-none"
					oncontextmenu={(e) => { e.preventDefault(); showAppMenu(e.clientX, e.clientY); }}
				>
					Right-click for options
				</div>
			{/if}
		</div>
	</div>

	<!-- Status bar -->
	<SyncStatus
		progress={syncProgress}
		lastResult={lastSyncResult}
		lastSyncTime={lastSyncTime}
		{contactCount}
	/>

	<!-- Notification banner -->
	{#if notification}
		<div class="border-surface-200-800 bg-surface-100 dark:bg-surface-800 fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-lg">
			{notification}
		</div>
	{/if}
</div>

<!-- Overlays -->
{#if showEditor}
	<ContactEditor
		card={showEditor && detailCard ? detailCard : null}
		collections={enabledCollections}
		{defaultCollectionId}
		currentCollectionId={selectedRow?.collectionId ?? null}
		onSave={handleEditorSave}
		onCancel={handleEditorCancel}
	/>
{/if}

{#if showAccountSettings}
	<AccountSettings
		{accounts}
		onClose={() => (showAccountSettings = false)}
		onChanged={async () => {
			await loadAccounts();
			await loadContacts();
		}}
	/>
{/if}

{#if showImport}
	<ImportPanel
		collections={enabledCollections}
		{defaultCollectionId}
		initialVcfText={importInitialVcf}
		onClose={() => { showImport = false; importInitialVcf = null; refreshContacts(); }}
	/>
{/if}

{#if showDuplicatePanel && duplicatePairs.length > 0}
	<DuplicatePanel
		pairs={duplicatePairs}
		{contacts}
		currentIdx={duplicatePairIdx}
		onSkip={handleDuplicateSkip}
		onMerge={handleDuplicateMerge}
		onClose={() => (showDuplicatePanel = false)}
	/>
{/if}

{#if contextMenu}
	<ContextMenu
		x={contextMenu.x}
		y={contextMenu.y}
		items={contextMenu.items}
		onClose={closeContextMenu}
	/>
{/if}
