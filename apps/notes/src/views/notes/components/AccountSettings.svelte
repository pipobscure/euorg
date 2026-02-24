<script lang="ts">
	import type { Account } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	let {
		accounts,
		onClose,
		onAccountsChanged,
	}: {
		accounts: Account[];
		onClose: () => void;
		onAccountsChanged: () => void;
	} = $props();

	// Form state
	let showAddForm = $state(false);
	let testResult = $state<{ ok: boolean; error?: string } | null>(null);
	let testing = $state(false);
	let saving = $state(false);

	let form = $state({
		name: "",
		host: "",
		port: 993,
		secure: true,
		username: "",
		password: "",
		notesFolder: "Notes",
	});

	function resetForm() {
		form = { name: "", host: "", port: 993, secure: true, username: "", password: "", notesFolder: "Notes" };
		testResult = null;
	}

	async function testConnection() {
		testing = true;
		testResult = null;
		try {
			testResult = await rpc.request.testAccount({
				host: form.host,
				port: form.port,
				secure: form.secure,
				username: form.username,
				password: form.password,
			});
		} finally {
			testing = false;
		}
	}

	async function addAccount() {
		saving = true;
		try {
			await rpc.request.addAccount({ ...form });
			resetForm();
			showAddForm = false;
			onAccountsChanged();
		} finally {
			saving = false;
		}
	}

	async function removeAccount(id: string) {
		if (!confirm("Remove this account? Local notes will be deleted from this device.")) return;
		await rpc.request.deleteAccount({ id });
		onAccountsChanged();
	}

	async function toggleAccount(account: Account) {
		await rpc.request.updateAccount({ id: account.id, enabled: !account.enabled });
		onAccountsChanged();
	}
</script>

<div class="flex flex-col h-full">
	<!-- Header -->
	<div class="flex items-center justify-between px-4 py-3 border-b border-surface-200-800">
		<h2 class="font-semibold text-sm">IMAP Accounts</h2>
		<button class="btn-icon btn-icon-sm hover:preset-tonal rounded" onclick={onClose}>
			<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path d="M18 6 6 18M6 6l12 12"/>
			</svg>
		</button>
	</div>

	<!-- Account list -->
	<div class="flex-1 overflow-y-auto p-4 space-y-3">
		{#each accounts as account (account.id)}
			<div class="card preset-outlined p-3 space-y-2">
				<div class="flex items-start justify-between gap-2">
					<div class="min-w-0">
						<div class="font-medium text-sm truncate">{account.name}</div>
						<div class="text-xs text-surface-600-400 truncate">{account.username} @ {account.host}:{account.port}</div>
						<div class="text-xs text-surface-500 mt-0.5">Folder: {account.notesFolder}</div>
					</div>
					<div class="flex items-center gap-1 shrink-0">
						<button
							class="text-xs px-2 py-0.5 rounded {account.enabled ? 'preset-tonal-success' : 'preset-outlined'}"
							onclick={() => toggleAccount(account)}
						>
							{account.enabled ? "On" : "Off"}
						</button>
						<button
							class="btn-icon btn-icon-sm hover:preset-tonal-error rounded"
							onclick={() => removeAccount(account.id)}
							title="Remove account"
						>
							<svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<polyline points="3 6 5 6 21 6"/><path d="M19 6 18.1 20a2 2 0 0 1-2 1.9H7.9a2 2 0 0 1-2-1.9L5 6m5 0V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2"/>
							</svg>
						</button>
					</div>
				</div>
			</div>
		{/each}

		{#if accounts.length === 0 && !showAddForm}
			<p class="text-sm text-surface-500 text-center py-6">No IMAP accounts configured.<br>Add one to sync your notes.</p>
		{/if}

		<!-- Add account form -->
		{#if showAddForm}
			<div class="card preset-outlined p-4 space-y-3">
				<h3 class="text-sm font-medium">New IMAP Account</h3>

				<label class="label">
					<span class="label-text text-xs">Display Name</span>
					<input class="input input-sm" bind:value={form.name} placeholder="e.g. mailbox.org" />
				</label>

				<label class="label">
					<span class="label-text text-xs">IMAP Host</span>
					<input class="input input-sm" bind:value={form.host} placeholder="imap.example.com" />
				</label>

				<div class="grid grid-cols-2 gap-2">
					<label class="label">
						<span class="label-text text-xs">Port</span>
						<input class="input input-sm" type="number" bind:value={form.port} />
					</label>
					<label class="label items-center gap-2 pt-4">
						<input type="checkbox" class="checkbox" bind:checked={form.secure} />
						<span class="text-xs">TLS</span>
					</label>
				</div>

				<label class="label">
					<span class="label-text text-xs">Username</span>
					<input class="input input-sm" bind:value={form.username} autocomplete="username" />
				</label>

				<label class="label">
					<span class="label-text text-xs">Password</span>
					<input class="input input-sm" type="password" bind:value={form.password} autocomplete="current-password" />
				</label>

				<label class="label">
					<span class="label-text text-xs">Notes Folder</span>
					<input class="input input-sm" bind:value={form.notesFolder} placeholder="Notes" />
				</label>

				{#if testResult}
					<div class="text-xs rounded px-2 py-1 {testResult.ok ? 'preset-tonal-success' : 'preset-tonal-error'}">
						{testResult.ok ? "✓ Connection successful" : `✗ ${testResult.error}`}
					</div>
				{/if}

				<div class="flex gap-2 justify-end pt-1">
					<button class="btn btn-sm preset-outlined" onclick={() => { showAddForm = false; resetForm(); }}>
						Cancel
					</button>
					<button class="btn btn-sm preset-outlined-primary" onclick={testConnection} disabled={testing || !form.host || !form.username}>
						{testing ? "Testing…" : "Test"}
					</button>
					<button class="btn btn-sm preset-filled-primary" onclick={addAccount} disabled={saving || !form.host || !form.username || !form.password}>
						{saving ? "Adding…" : "Add"}
					</button>
				</div>
			</div>
		{/if}
	</div>

	<!-- Footer -->
	<div class="px-4 py-3 border-t border-surface-200-800">
		{#if !showAddForm}
			<button class="btn btn-sm preset-filled-primary w-full" onclick={() => showAddForm = true}>
				+ Add IMAP Account
			</button>
		{/if}
	</div>
</div>
