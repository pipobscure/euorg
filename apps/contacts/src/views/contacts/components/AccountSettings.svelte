<script lang="ts">
	import type { Account, Collection } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		accounts: Account[];
		onClose: () => void;
		onChanged: () => void;
	}

	let { accounts, onClose, onChanged }: Props = $props();

	// Expanded account sections
	let expanded = $state<Record<string, boolean>>({});
	let collectionsCache = $state<Record<string, Collection[]>>({});

	// Per-account password update state
	let updatePasswordFor = $state<string | null>(null);
	let updatePasswordValue = $state("");
	let updatePasswordError = $state("");
	let updatePasswordSaving = $state(false);

	// Per-account delete confirmation state
	let confirmDeleteFor = $state<string | null>(null);

	// New account form
	let showAddForm = $state(false);
	let newName = $state("");
	let newUrl = $state("");
	let newUser = $state("");
	let newPass = $state("");
	let addError = $state("");
	let addTesting = $state(false);
	let addSaving = $state(false);

	// Keystore config
	let keystoreType = $state("auto");
	rpc.request.getKeystoreType().then((t) => (keystoreType = t ?? "auto"));

	async function loadCollections(accountId: string) {
		const cols = await rpc.request.getCollections({ accountId });
		collectionsCache = { ...collectionsCache, [accountId]: cols ?? [] };
	}

	async function toggleExpanded(accountId: string) {
		expanded = { ...expanded, [accountId]: !expanded[accountId] };
		if (expanded[accountId] && !collectionsCache[accountId]) {
			await loadCollections(accountId);
		}
	}

	async function toggleAccount(account: Account) {
		await rpc.request.updateAccount({ id: account.id, enabled: !account.enabled });
		onChanged();
	}

	async function toggleCollection(col: Collection) {
		await rpc.request.setCollectionEnabled({ accountId: col.accountId, collectionId: col.id, enabled: !col.enabled });
		await loadCollections(col.accountId);
		onChanged();
	}

	async function setDefault(accountId: string, collectionId: string) {
		await rpc.request.setDefaultCollection({ accountId, collectionId });
		onChanged();
	}

	async function rediscover(accountId: string) {
		await rpc.request.rediscoverCollections({ accountId });
		await loadCollections(accountId);
		onChanged();
	}

	async function deleteAccount(id: string) {
		if (confirmDeleteFor !== id) {
			confirmDeleteFor = id;
			// Auto-reset after 4 seconds
			setTimeout(() => { if (confirmDeleteFor === id) confirmDeleteFor = null; }, 4000);
			return;
		}
		confirmDeleteFor = null;
		await rpc.request.deleteAccount({ id });
		onChanged();
	}

	async function startUpdatePassword(account: Account) {
		updatePasswordFor = account.id;
		updatePasswordValue = "";
		updatePasswordError = "";
	}

	async function savePassword(account: Account) {
		if (!updatePasswordValue) {
			updatePasswordError = "Password is required";
			return;
		}
		updatePasswordSaving = true;
		updatePasswordError = "";
		try {
			await rpc.request.updateAccount({ id: account.id, password: updatePasswordValue });
			updatePasswordFor = null;
			updatePasswordValue = "";
		} catch (e) {
			updatePasswordError = e instanceof Error ? e.message : String(e);
		} finally {
			updatePasswordSaving = false;
		}
	}

	async function testNew() {
		addTesting = true;
		addError = "";
		const r = await rpc.request.testAccount({ serverUrl: newUrl, username: newUser, password: newPass });
		addTesting = false;
		if (r?.ok) {
			addError = "✓ Connection successful";
		} else {
			addError = "Error: " + (r?.error ?? "unknown");
		}
	}

	async function saveNew() {
		if (!newName || !newUrl || !newUser || !newPass) {
			addError = "All fields are required";
			return;
		}
		addSaving = true;
		addError = "";
		try {
			await rpc.request.addAccount({ name: newName, serverUrl: newUrl, username: newUser, password: newPass });
			newName = newUrl = newUser = newPass = "";
			showAddForm = false;
			onChanged();
		} catch (e) {
			addError = e instanceof Error ? e.message : String(e);
		} finally {
			addSaving = false;
		}
	}

	async function saveKeystoreType() {
		await rpc.request.setKeystoreType({ type: keystoreType });
	}
</script>

<!-- Drawer overlay -->
<div
	class="fixed inset-0 z-40 flex justify-end"
	role="dialog"
	aria-modal="true"
>
	<!-- Backdrop -->
	<button
		class="absolute inset-0 bg-black/40"
		onclick={onClose}
		aria-label="Close settings"
	></button>

	<!-- Panel -->
	<div class="bg-surface-50-950 relative z-10 flex h-full w-96 flex-col shadow-2xl">
		<!-- Header -->
		<div class="border-surface-200-800 flex items-center justify-between border-b px-4 py-3">
			<h2 class="font-semibold">Account Settings</h2>
			<button class="text-surface-400 hover:text-surface-600 text-xl leading-none" onclick={onClose}>×</button>
		</div>

		<div class="flex-1 overflow-y-auto p-4 space-y-4">
			<!-- Accounts list -->
			{#each accounts as account}
				<div class="border-surface-200-800 rounded-lg border">
					<!-- Account header -->
					<div class="flex items-center gap-2 p-3">
						<button
							class="mr-1 text-base leading-none"
							onclick={() => toggleExpanded(account.id)}
							aria-label={expanded[account.id] ? "Collapse" : "Expand"}
						>
							{expanded[account.id] ? "▾" : "▸"}
						</button>
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{account.name}</div>
							<div class="text-surface-400 truncate text-xs">{account.username}</div>
						</div>
						<!-- Enable toggle -->
						<label class="flex items-center gap-1 text-xs">
							<input
								type="checkbox"
								class="checkbox"
								checked={account.enabled}
								onchange={() => toggleAccount(account)}
							/>
							On
						</label>
						<button
							class="text-xs hover:underline {confirmDeleteFor === account.id ? 'text-error-600 font-semibold' : 'text-error-500'}"
							onclick={() => deleteAccount(account.id)}
						>
							{confirmDeleteFor === account.id ? "Confirm?" : "Delete"}
						</button>
					</div>

					<!-- Password update inline form -->
					{#if updatePasswordFor === account.id}
						<div class="border-surface-200-800 border-t bg-surface-100-900 px-3 py-2 space-y-2">
							<p class="text-xs font-medium">Update password</p>
							<input
								class="input w-full text-sm"
								type="password"
								placeholder="New password"
								bind:value={updatePasswordValue}
								autocomplete="current-password"
							/>
							{#if updatePasswordError}
								<p class="text-error-500 text-xs">{updatePasswordError}</p>
							{/if}
							<div class="flex gap-2">
								<button class="btn preset-outlined-surface-500 flex-1 text-xs" onclick={() => { updatePasswordFor = null; }}>Cancel</button>
								<button class="btn preset-filled-primary-500 flex-1 text-xs" onclick={() => savePassword(account)} disabled={updatePasswordSaving}>
									{updatePasswordSaving ? "Saving…" : "Save"}
								</button>
							</div>
						</div>
					{/if}

					<!-- Collections -->
					{#if expanded[account.id]}
						<div class="border-surface-200-800 border-t px-3 pb-3 pt-2">
							{#if !collectionsCache[account.id]}
								<p class="text-surface-400 text-xs">Loading…</p>
							{:else if collectionsCache[account.id].length === 0}
								<p class="text-surface-400 text-xs">No collections found</p>
							{:else}
								{#each collectionsCache[account.id] as col}
									<div class="mb-2 flex items-center gap-2">
										<input
											type="checkbox"
											class="checkbox"
											checked={col.enabled}
											onchange={() => toggleCollection(col)}
										/>
										<span class="min-w-0 flex-1 truncate text-xs">{col.name}</span>
										{#if account.defaultCollectionId === col.id}
											<span class="text-primary-500 text-xs">default</span>
										{:else}
											<button
												class="text-surface-400 text-xs hover:underline"
												onclick={() => setDefault(account.id, col.id)}
											>set default</button>
										{/if}
									</div>
								{/each}
							{/if}
							<div class="mt-2 flex gap-3">
								<button
									class="text-primary-500 text-xs hover:underline"
									onclick={() => rediscover(account.id)}
								>Re-discover collections</button>
								<button
									class="text-surface-400 text-xs hover:underline"
									onclick={() => startUpdatePassword(account)}
								>Update password</button>
							</div>
						</div>
					{/if}
				</div>
			{/each}

			<!-- Add account -->
			{#if !showAddForm}
				<button
					class="btn preset-outlined-primary-500 w-full"
					onclick={() => { showAddForm = true; addError = ""; }}
				>
					+ Add CardDAV Account
				</button>
			{:else}
				<div class="border-surface-200-800 rounded-lg border p-3 space-y-2">
					<h3 class="text-sm font-medium">New Account</h3>
					<input class="input w-full text-sm" type="text" placeholder="Display name" bind:value={newName} />
					<input class="input w-full text-sm" type="url" placeholder="Server URL (https://…)" bind:value={newUrl} />
					<input class="input w-full text-sm" type="text" placeholder="Username" bind:value={newUser} autocomplete="off" />
					<input class="input w-full text-sm" type="password" placeholder="Password" bind:value={newPass} autocomplete="new-password" />
					{#if addError}
						<p class="text-xs {addError.startsWith('✓') ? 'text-success-500' : 'text-error-500'}">{addError}</p>
					{/if}
					<div class="flex gap-2">
						<button class="btn preset-outlined-surface-500 flex-1 text-sm" onclick={() => { showAddForm = false; addError = ""; }}>Cancel</button>
						<button class="btn preset-outlined-primary-500 text-sm" onclick={testNew} disabled={addTesting}>
							{addTesting ? "Testing…" : "Test"}
						</button>
						<button class="btn preset-filled-primary-500 flex-1 text-sm" onclick={saveNew} disabled={addSaving}>
							{addSaving ? "Saving…" : "Save"}
						</button>
					</div>
				</div>
			{/if}

			<!-- Keystore config -->
			<div class="border-surface-200-800 rounded-lg border p-3">
				<h3 class="mb-2 text-sm font-medium">Credential Storage</h3>
				<select class="select w-full text-sm" bind:value={keystoreType} onchange={saveKeystoreType}>
					<option value="auto">Auto (recommended)</option>
					<option value="secret-service">Secret Service (GNOME Keyring / libsecret)</option>
					<option value="kwallet">KWallet (KDE)</option>
					<option value="macos-keychain">macOS Keychain</option>
					<option value="windows">Windows Credential Manager</option>
					<option value="plaintext">Plaintext (insecure fallback)</option>
				</select>
				<p class="text-surface-400 mt-1 text-xs">
					Stored in ~/.euorg/config.json. Applies to all euorg apps.
				</p>
			</div>
		</div>
	</div>
</div>
