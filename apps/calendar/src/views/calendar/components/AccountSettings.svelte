<script lang="ts">
	import type { AccountView, CalendarView, CalendarPrefs, ViewMode } from "../lib/types.ts";
	import { getLocaleWeekStart } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		accounts: AccountView[];
		calendars: CalendarView[];
		prefs: CalendarPrefs;
		onClose: () => void;
		onPrefChange: (updated: CalendarPrefs) => void;
		onAccountsChange: (accounts: AccountView[], calendars: CalendarView[]) => void;
	}

	let { accounts, calendars, prefs, onClose, onPrefChange, onAccountsChange }: Props = $props();

	// ── Tabs ─────────────────────────────────────────────────────────────────
	let activeTab = $state<"prefs" | "accounts">("prefs");

	// ── Local state ───────────────────────────────────────────────────────────
	let localAccounts = $state([...accounts]);
	let localCalendars = $state([...calendars]);

	let isLoading = $state(false);
	let error = $state<string | null>(null);
	let successMsg = $state<string | null>(null);

	function showSuccess(msg: string) { successMsg = msg; error = null; setTimeout(() => { successMsg = null; }, 3000); }
	function showError(msg: string) { error = msg; successMsg = null; }

	// ── Preferences ──────────────────────────────────────────────────────────
	const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => {
		const label = h === 0 ? "12:00 AM" : h < 12 ? `${h}:00 AM` : h === 12 ? "12:00 PM" : `${h - 12}:00 PM`;
		return { value: h, label };
	});

	async function setPref(key: keyof CalendarPrefs, value: CalendarPrefs[typeof key]) {
		const updated = { ...prefs, [key]: value };
		onPrefChange(updated);
		const rpcValue = key === "startOfWeek" && value === getLocaleWeekStart() ? "locale" : value;
		await rpc.request.setCalendarPrefs({ [key]: rpcValue });
	}

	// ── Account selection ─────────────────────────────────────────────────────
	let selectedAccountId = $state<string>(localAccounts[0]?.id ?? "");
	let mode = $state<"view" | "addDav" | "addSmtp" | "addSubscription">("view");

	const selectedAccount = $derived(localAccounts.find((a) => a.id === selectedAccountId));
	const davAccounts = $derived(localAccounts.filter((a) => a.accountType === "dav"));
	const smtpAccounts = $derived(localAccounts.filter((a) => a.accountType === "smtp"));
	const subAccounts = $derived(localAccounts.filter((a) => a.accountType === "subscription"));
	const accountCalendars = $derived(localCalendars.filter((c) => c.accountId === selectedAccountId));

	function selectAccount(id: string) { selectedAccountId = id; mode = "view"; }

	function pushChanges() {
		onAccountsChange([...localAccounts], [...localCalendars]);
	}

	// ── Add CalDAV account ────────────────────────────────────────────────────
	let davName = $state(""); let davServer = $state(""); let davUsername = $state(""); let davPassword = $state("");

	async function handleAddDav() {
		if (!davName || !davServer || !davUsername || !davPassword) return;
		isLoading = true;
		try {
			const account = await rpc.request.addAccount({ name: davName, serverUrl: davServer, username: davUsername, password: davPassword });
			localAccounts = [...localAccounts, account];
			selectedAccountId = account.id;
			mode = "view";
			davName = davServer = davUsername = davPassword = "";
			const cals = await rpc.request.getCalendars({ accountId: account.id });
			localCalendars = [...localCalendars, ...cals];
			pushChanges();
			showSuccess("CalDAV account added");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to add account"); }
		isLoading = false;
	}

	async function handleTestDav() {
		isLoading = true;
		const r = await rpc.request.testAccount({ serverUrl: davServer, username: davUsername, password: davPassword });
		isLoading = false;
		if (r.ok) showSuccess("Connection successful"); else showError(r.error ?? "Connection failed");
	}

	// ── Add SMTP account ──────────────────────────────────────────────────────
	let smtpName = $state(""); let smtpHost = $state(""); let smtpPort = $state(587);
	let smtpSecure = $state(false); let smtpUsername = $state(""); let smtpPassword = $state("");
	let smtpFromName = $state(""); let smtpFromEmail = $state("");

	async function handleAddSmtp() {
		if (!smtpName || !smtpHost || !smtpUsername || !smtpPassword) return;
		isLoading = true;
		try {
			const account = await rpc.request.addSmtpAccount({
				name: smtpName, host: smtpHost, port: smtpPort, secure: smtpSecure,
				username: smtpUsername, password: smtpPassword,
				fromName: smtpFromName, fromEmail: smtpFromEmail,
			});
			localAccounts = [...localAccounts, account];
			selectedAccountId = account.id;
			mode = "view";
			smtpName = smtpHost = smtpUsername = smtpPassword = smtpFromName = smtpFromEmail = "";
			smtpPort = 587; smtpSecure = false;
			pushChanges();
			showSuccess("SMTP account added");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to add SMTP account"); }
		isLoading = false;
	}

	async function handleTestSmtp() {
		if (!smtpHost || !smtpUsername || !smtpPassword) return;
		isLoading = true;
		const r = await rpc.request.testSmtpCredentials({
			host: smtpHost, port: smtpPort, secure: smtpSecure,
			username: smtpUsername, password: smtpPassword,
		});
		isLoading = false;
		if (r.ok) showSuccess("SMTP connection successful"); else showError(r.error ?? "Failed");
	}

	// ── Edit SMTP account (view mode) ─────────────────────────────────────────
	let editSmtpHost = $state(""); let editSmtpPort = $state(587); let editSmtpSecure = $state(false);
	let editSmtpUsername = $state(""); let editSmtpPassword = $state("");
	let editSmtpFromName = $state(""); let editSmtpFromEmail = $state(""); let editSmtpName = $state("");

	$effect(() => {
		if (selectedAccount?.accountType === "smtp") {
			editSmtpName = selectedAccount.name;
			editSmtpHost = selectedAccount.smtpHost;
			editSmtpPort = selectedAccount.smtpPort;
			editSmtpSecure = selectedAccount.smtpSecure;
			editSmtpUsername = selectedAccount.username;
			editSmtpPassword = "";
			editSmtpFromName = selectedAccount.smtpFromName;
			editSmtpFromEmail = selectedAccount.smtpFromEmail;
		}
	});

	async function handleSaveSmtp() {
		if (!selectedAccount || selectedAccount.accountType !== "smtp") return;
		isLoading = true;
		try {
			const updated = await rpc.request.updateSmtpAccount({
				id: selectedAccount.id,
				name: editSmtpName, host: editSmtpHost, port: editSmtpPort, secure: editSmtpSecure,
				username: editSmtpUsername,
				...(editSmtpPassword ? { password: editSmtpPassword } : {}),
				fromName: editSmtpFromName, fromEmail: editSmtpFromEmail,
			});
			localAccounts = localAccounts.map((a) => a.id === updated.id ? updated : a);
			pushChanges();
			showSuccess("SMTP account saved");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to save"); }
		isLoading = false;
	}

	async function handleTestSelectedSmtp() {
		if (!selectedAccount || selectedAccount.accountType !== "smtp") return;
		isLoading = true;
		// Always use form values for connection params; fall back to keystore password if not typed
		const r = await rpc.request.testSmtpCredentials({
			host: editSmtpHost, port: editSmtpPort, secure: editSmtpSecure,
			username: editSmtpUsername,
			...(editSmtpPassword ? { password: editSmtpPassword } : { accountId: selectedAccount.id }),
		});
		isLoading = false;
		if (r.ok) showSuccess("SMTP connection successful"); else showError(r.error ?? "Failed");
	}

	// ── CalDAV account actions ────────────────────────────────────────────────
	async function handleRediscoverCalendars() {
		if (!selectedAccountId) return;
		isLoading = true;
		try {
			const cals = await rpc.request.rediscoverCalendars({ accountId: selectedAccountId });
			localCalendars = [...localCalendars.filter((c) => c.accountId !== selectedAccountId), ...cals];
			pushChanges();
			showSuccess(`Found ${cals.length} calendar(s)`);
		} catch (e) { showError(e instanceof Error ? e.message : "Discovery failed"); }
		isLoading = false;
	}

	async function handleToggleCalendar(calId: string, enabled: boolean) {
		await rpc.request.setCalendarEnabled({ accountId: selectedAccountId, calendarId: calId, enabled });
		localCalendars = localCalendars.map((c) => c.id === calId ? { ...c, enabled } : c);
		pushChanges();
	}

	async function handleColorChange(calId: string, color: string) {
		await rpc.request.setCalendarColor({ accountId: selectedAccountId, calendarId: calId, color });
		localCalendars = localCalendars.map((c) => c.id === calId ? { ...c, color } : c);
		pushChanges();
	}

	async function handleDeleteAccount(id: string) {
		if (!confirm("Delete this account and all its local data?")) return;
		await rpc.request.deleteAccount({ id });
		localAccounts = localAccounts.filter((a) => a.id !== id);
		localCalendars = localCalendars.filter((c) => c.accountId !== id);
		selectedAccountId = localAccounts[0]?.id ?? "";
		mode = "view";
		pushChanges();
	}

	// ── Add/Delete CalDAV calendars ───────────────────────────────────────────
	let showAddCalendarForm = $state(false);
	let newCalName = $state(""); let newCalColor = $state("#6366f1");

	async function handleAddCalendar() {
		if (!newCalName || !selectedAccountId) return;
		isLoading = true;
		try {
			const cal = await rpc.request.addCalendar({ accountId: selectedAccountId, name: newCalName, color: newCalColor });
			localCalendars = [...localCalendars, cal];
			newCalName = ""; newCalColor = "#6366f1";
			showAddCalendarForm = false;
			pushChanges();
			showSuccess("Calendar created");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to create calendar"); }
		isLoading = false;
	}

	async function handleDeleteCalendar(calId: string, calName: string) {
		if (!confirm(`Delete calendar "${calName}" and all its events from the server?\nThis cannot be undone.`)) return;
		isLoading = true;
		try {
			await rpc.request.deleteCalendar({ accountId: selectedAccountId, calendarId: calId });
			localCalendars = localCalendars.filter((c) => c.id !== calId);
			pushChanges();
			showSuccess("Calendar deleted");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to delete calendar"); }
		isLoading = false;
	}

	// ── ICS Subscriptions ─────────────────────────────────────────────────────
	let subUrl = $state(""); let subName = $state(""); let subColor = $state("#10b981");

	async function handleAddSubscription() {
		if (!subUrl || !subName) return;
		isLoading = true;
		try {
			const { account, calendar } = await rpc.request.addSubscription({ url: subUrl, name: subName, color: subColor });
			localAccounts = [...localAccounts, account];
			localCalendars = [...localCalendars, calendar];
			selectedAccountId = account.id;
			mode = "view";
			subUrl = subName = ""; subColor = "#10b981";
			pushChanges();
			showSuccess("Subscription added — sync to fetch events");
		} catch (e) { showError(e instanceof Error ? e.message : "Failed to add subscription"); }
		isLoading = false;
	}
</script>

<!-- Single-root overlay -->
<div class="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true">
	<button class="absolute inset-0 bg-black/40" onclick={onClose} aria-label="Close settings"></button>

	<div class="relative z-10 flex h-full w-[520px] flex-col bg-surface-50-950 shadow-2xl border-l border-surface-200-800">
		<!-- Header -->
		<div class="flex items-center justify-between border-b border-surface-200-800 px-5 py-4 shrink-0">
			<h2 class="text-base font-semibold text-surface-900-100">Settings</h2>
			<button onclick={onClose} class="p-1 rounded-lg hover:bg-surface-100-900 text-surface-500-400">
				<svg class="size-5" viewBox="0 0 20 20" fill="currentColor">
					<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
				</svg>
			</button>
		</div>

		<!-- Tabs -->
		<div class="flex border-b border-surface-200-800 shrink-0">
			<button onclick={() => { activeTab = "prefs"; }}
				class="flex-1 py-2.5 text-sm font-medium transition-colors
					{activeTab === 'prefs' ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-400' : 'text-surface-600-400 hover:text-surface-900-100'}"
			>Preferences</button>
			<button onclick={() => { activeTab = "accounts"; }}
				class="flex-1 py-2.5 text-sm font-medium transition-colors
					{activeTab === 'accounts' ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-400' : 'text-surface-600-400 hover:text-surface-900-100'}"
			>Accounts</button>
		</div>

		<!-- Status messages -->
		{#if error}
			<div class="mx-5 mt-3 shrink-0 rounded-lg bg-error-50 px-3 py-2 text-sm text-error-700">{error}</div>
		{/if}
		{#if successMsg}
			<div class="mx-5 mt-3 shrink-0 rounded-lg bg-success-50 px-3 py-2 text-sm text-success-700">{successMsg}</div>
		{/if}

		<!-- Tab content -->
		{#if activeTab === "prefs"}
			<div class="flex-1 overflow-y-auto p-5 space-y-6">
				<!-- Week numbers -->
				<div class="flex items-center justify-between rounded-lg border border-surface-200-800 bg-surface-100-900 px-4 py-3">
					<div>
						<p class="text-sm font-medium text-surface-900-100">Show week numbers</p>
						<p class="text-xs text-surface-500-400">ISO 8601 week number in all views</p>
					</div>
					<button
						role="switch"
						aria-checked={prefs.showWeekNumbers}
						onclick={() => setPref("showWeekNumbers", !prefs.showWeekNumbers)}
						class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors
							{prefs.showWeekNumbers ? 'bg-primary-500' : 'bg-surface-300-700'}"
					>
						<span class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform
							{prefs.showWeekNumbers ? 'translate-x-5' : 'translate-x-0'}" />
					</button>
				</div>

				<!-- Start of week -->
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-surface-700-300">Start of week</label>
					<div class="flex rounded-lg overflow-hidden border border-surface-200-800">
						<button onclick={() => setPref("startOfWeek", "monday")}
							class="flex-1 py-1.5 text-sm transition-colors {prefs.startOfWeek === 'monday' ? 'bg-primary-500 text-white' : 'hover:bg-surface-100-900'}"
						>Monday</button>
						<button onclick={() => setPref("startOfWeek", "sunday")}
							class="flex-1 py-1.5 text-sm transition-colors {prefs.startOfWeek === 'sunday' ? 'bg-primary-500 text-white' : 'hover:bg-surface-100-900'}"
						>Sunday</button>
					</div>
				</div>

				<!-- Default view -->
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-surface-700-300">Default view</label>
					<div class="flex rounded-lg overflow-hidden border border-surface-200-800">
						{#each [["day", "Day"], ["week", "Week"], ["month", "Month"]] as entry}
							<button onclick={() => setPref("defaultView", entry[0] as ViewMode)}
								class="flex-1 py-1.5 text-sm transition-colors {prefs.defaultView === entry[0] ? 'bg-primary-500 text-white' : 'hover:bg-surface-100-900'}"
							>{entry[1]}</button>
						{/each}
					</div>
				</div>

				<!-- Day starts at -->
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-surface-700-300">Day starts at</label>
					<select value={prefs.dayStart} onchange={(e) => setPref("dayStart", Number((e.target as HTMLSelectElement).value))} class="select w-full text-sm">
						{#each HOUR_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
					</select>
					<p class="text-xs text-surface-500-400">Controls where the week/day view scrolls to on open.</p>
				</div>

				<!-- Day ends at -->
				<div class="space-y-1.5">
					<label class="text-sm font-medium text-surface-700-300">Day ends at</label>
					<select value={prefs.dayEnd} onchange={(e) => setPref("dayEnd", Number((e.target as HTMLSelectElement).value))} class="select w-full text-sm">
						{#each HOUR_OPTIONS as opt}<option value={opt.value}>{opt.label}</option>{/each}
					</select>
				</div>
			</div>

		{:else}
			<!-- ── Accounts Tab ──────────────────────────────────────────────── -->
			<div class="flex flex-1 overflow-hidden">

				<!-- Left sidebar -->
				<div class="w-48 shrink-0 border-r border-surface-200-800 flex flex-col overflow-hidden">
					<div class="flex-1 overflow-y-auto">

						<!-- CalDAV section -->
						<div class="px-3 pt-3 pb-1">
							<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-400-600">CalDAV</p>
						</div>
						{#each davAccounts as a (a.id)}
							<button
								onclick={() => selectAccount(a.id)}
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-100-900
									{mode === 'view' && selectedAccountId === a.id ? 'bg-primary-50 dark:bg-primary-950 text-primary-700 dark:text-primary-300 font-medium' : 'text-surface-700-300'}"
							>
								<svg class="size-3.5 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
									<path fill-rule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Z" clip-rule="evenodd"/>
								</svg>
								<span class="flex-1 truncate">{a.name}</span>
							</button>
						{/each}
						<button
							onclick={() => { mode = "addDav"; selectedAccountId = ""; }}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-primary-500 hover:bg-surface-100-900
								{mode === 'addDav' ? 'bg-primary-50 dark:bg-primary-950 font-medium' : ''}"
						>
							<svg class="size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
								<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/>
							</svg>
							Add CalDAV
						</button>

						<!-- SMTP section -->
						<div class="px-3 pt-4 pb-1 mt-1 border-t border-surface-200-800">
							<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-400-600">SMTP</p>
						</div>
						{#each smtpAccounts as a (a.id)}
							<button
								onclick={() => selectAccount(a.id)}
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-100-900
									{mode === 'view' && selectedAccountId === a.id ? 'bg-primary-50 dark:bg-primary-950 text-primary-700 dark:text-primary-300 font-medium' : 'text-surface-700-300'}"
							>
								<svg class="size-3.5 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
									<path d="M3 4a2 2 0 0 0-2 2v1.161l8.441 4.221a1.25 1.25 0 0 0 1.118 0L19 7.162V6a2 2 0 0 0-2-2H3Z"/>
									<path d="m19 8.839-7.77 3.885a2.75 2.75 0 0 1-2.46 0L1 8.839V14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.839Z"/>
								</svg>
								<span class="flex-1 truncate">{a.name}</span>
							</button>
						{/each}
						<button
							onclick={() => { mode = "addSmtp"; selectedAccountId = ""; }}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-primary-500 hover:bg-surface-100-900
								{mode === 'addSmtp' ? 'bg-primary-50 dark:bg-primary-950 font-medium' : ''}"
						>
							<svg class="size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
								<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/>
							</svg>
							Add SMTP
						</button>

						<!-- Subscriptions section -->
						<div class="px-3 pt-4 pb-1 mt-1 border-t border-surface-200-800">
							<p class="text-[10px] font-semibold uppercase tracking-wider text-surface-400-600">Subscriptions</p>
						</div>
						{#each subAccounts as a (a.id)}
							<button
								onclick={() => selectAccount(a.id)}
								class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-100-900
									{mode === 'view' && selectedAccountId === a.id ? 'bg-primary-50 dark:bg-primary-950 text-primary-700 dark:text-primary-300 font-medium' : 'text-surface-700-300'}"
							>
								<svg class="size-3.5 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
									<path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd"/>
								</svg>
								<span class="flex-1 truncate">{a.name}</span>
							</button>
						{/each}
						<button
							onclick={() => { mode = "addSubscription"; selectedAccountId = ""; }}
							class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-primary-500 hover:bg-surface-100-900
								{mode === 'addSubscription' ? 'bg-primary-50 dark:bg-primary-950 font-medium' : ''}"
						>
							<svg class="size-3.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
								<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/>
							</svg>
							Add Subscription
						</button>
					</div>
				</div>

				<!-- Right panel -->
				<div class="flex-1 overflow-y-auto p-5">

					{#if mode === "addDav"}
						<div class="space-y-3">
							<h3 class="font-medium text-surface-900-100">Add CalDAV Account</h3>
							<input type="text" bind:value={davName} placeholder="Display name" class="input w-full text-sm" />
							<input type="url" bind:value={davServer} placeholder="Server URL (https://...)" class="input w-full text-sm" />
							<input type="text" bind:value={davUsername} placeholder="Username" class="input w-full text-sm" />
							<input type="password" bind:value={davPassword} placeholder="Password" class="input w-full text-sm" />
							<div class="flex gap-2">
								<button onclick={handleTestDav} disabled={isLoading} class="btn preset-ghost px-3 py-1.5 text-sm">Test</button>
								<button onclick={handleAddDav} disabled={isLoading || !davName || !davServer || !davUsername || !davPassword}
									class="btn preset-filled-primary-500 flex-1 py-1.5 text-sm">{isLoading ? "Adding…" : "Add account"}</button>
								<button onclick={() => { mode = "view"; }} class="btn preset-ghost px-3 py-1.5 text-sm">Cancel</button>
							</div>
						</div>

					{:else if mode === "addSmtp"}
						<div class="space-y-3">
							<h3 class="font-medium text-surface-900-100">Add SMTP Account</h3>
							<input type="text" bind:value={smtpName} placeholder="Display name (e.g. Work Email)" class="input w-full text-sm" />
							<input type="text" bind:value={smtpHost} placeholder="SMTP host (e.g. smtp.mailbox.org)" class="input w-full text-sm" />
							<div class="flex gap-2 items-center">
								<input type="number" bind:value={smtpPort} placeholder="Port" class="input w-24 text-sm" />
								<label class="flex items-center gap-2 text-sm text-surface-700-300">
									<input type="checkbox" bind:checked={smtpSecure} class="checkbox" />
									TLS (port 465)
								</label>
							</div>
							<input type="text" bind:value={smtpUsername} placeholder="Username / email" class="input w-full text-sm" />
							<input type="password" bind:value={smtpPassword} placeholder="Password" class="input w-full text-sm" />
							<input type="text" bind:value={smtpFromName} placeholder="From name" class="input w-full text-sm" />
							<input type="email" bind:value={smtpFromEmail} placeholder="From email" class="input w-full text-sm" />
							<div class="flex gap-2">
								<button onclick={handleAddSmtp} disabled={isLoading || !smtpName || !smtpHost || !smtpUsername || !smtpPassword}
									class="btn preset-filled-primary-500 flex-1 py-1.5 text-sm">{isLoading ? "Adding…" : "Add account"}</button>
								<button onclick={() => { mode = "view"; }} class="btn preset-ghost px-3 py-1.5 text-sm">Cancel</button>
							</div>
						</div>

					{:else if selectedAccount?.accountType === "dav"}
						<div class="space-y-4">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-surface-900-100">{selectedAccount.name}</h3>
								<button onclick={() => handleDeleteAccount(selectedAccount.id)} class="text-xs text-error-500 hover:underline">Remove</button>
							</div>
							<div class="text-xs text-surface-500-400">{selectedAccount.serverUrl}</div>

							<div class="flex items-center justify-between pt-1">
								<span class="text-sm font-medium text-surface-900-100">Calendars</span>
								<button onclick={handleRediscoverCalendars} disabled={isLoading} class="text-xs text-primary-500 hover:underline">
									{isLoading ? "Discovering…" : "Re-discover"}
								</button>
							</div>
							{#if accountCalendars.length === 0}
								<p class="text-sm text-surface-500-400">No calendars found. Click Re-discover.</p>
							{/if}
							{#each accountCalendars as cal (cal.id)}
								<div class="flex items-center gap-3 rounded-lg border border-surface-200-800 px-3 py-2">
									<input type="checkbox" checked={cal.enabled}
										onchange={(e) => handleToggleCalendar(cal.id, (e.target as HTMLInputElement).checked)}
										class="checkbox" />
									<input type="color" value={cal.color}
										onchange={(e) => handleColorChange(cal.id, (e.target as HTMLInputElement).value)}
										class="size-6 cursor-pointer rounded border-0 p-0" />
									<span class="flex-1 text-sm truncate">{cal.name}</span>
									<button
										onclick={() => handleDeleteCalendar(cal.id, cal.name)}
										class="p-1 text-surface-400-600 hover:text-error-500 rounded"
										title="Delete calendar"
									>
										<svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor">
											<path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193V3.75A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clip-rule="evenodd"/>
										</svg>
									</button>
								</div>
							{/each}

							{#if showAddCalendarForm}
								<div class="flex items-center gap-2 rounded-lg border border-primary-300 px-3 py-2">
									<input type="color" bind:value={newCalColor} class="size-6 cursor-pointer rounded border-0 p-0 shrink-0" />
									<input type="text" bind:value={newCalName} placeholder="Calendar name" class="input flex-1 text-sm py-0.5" />
									<button onclick={handleAddCalendar} disabled={isLoading || !newCalName} class="btn preset-filled-primary-500 text-xs px-2 py-1">
										{isLoading ? "…" : "Add"}
									</button>
									<button onclick={() => { showAddCalendarForm = false; newCalName = ""; }} class="btn preset-ghost text-xs px-2 py-1">✕</button>
								</div>
							{:else}
								<button onclick={() => { showAddCalendarForm = true; }} class="flex items-center gap-1.5 text-xs text-primary-500 hover:underline">
									<svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor">
										<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z"/>
									</svg>
								Add calendar
								</button>
							{/if}
						</div>

					{:else if selectedAccount?.accountType === "smtp"}
						<div class="space-y-3">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-surface-900-100">SMTP Account</h3>
								<button onclick={() => handleDeleteAccount(selectedAccount.id)} class="text-xs text-error-500 hover:underline">Remove</button>
							</div>
							<input type="text" bind:value={editSmtpName} placeholder="Display name" class="input w-full text-sm" />
							<input type="text" bind:value={editSmtpHost} placeholder="SMTP host" class="input w-full text-sm" />
							<div class="flex gap-2 items-center">
								<input type="number" bind:value={editSmtpPort} placeholder="Port" class="input w-24 text-sm" />
								<label class="flex items-center gap-2 text-sm text-surface-700-300">
									<input type="checkbox" bind:checked={editSmtpSecure} class="checkbox" />
									TLS (port 465)
								</label>
							</div>
							<input type="text" bind:value={editSmtpUsername} placeholder="Username" class="input w-full text-sm" />
							<input type="password" bind:value={editSmtpPassword} placeholder="Password (leave blank to keep)" class="input w-full text-sm" />
							<input type="text" bind:value={editSmtpFromName} placeholder="From name" class="input w-full text-sm" />
							<input type="email" bind:value={editSmtpFromEmail} placeholder="From email" class="input w-full text-sm" />
							<div class="flex gap-2">
								<button onclick={handleTestSelectedSmtp} disabled={isLoading} class="btn preset-ghost px-3 py-1.5 text-sm">Test</button>
								<button onclick={handleSaveSmtp} disabled={isLoading} class="btn preset-filled-primary-500 flex-1 py-1.5 text-sm">
									{isLoading ? "Saving…" : "Save"}
								</button>
							</div>
						</div>

					{:else if mode === "addSubscription"}
						<div class="space-y-3">
							<h3 class="font-medium text-surface-900-100">Add Calendar Subscription</h3>
							<p class="text-xs text-surface-500-400">Public ICS feed URL (e.g. public holidays, venue events). Read-only.</p>
							<input type="url" bind:value={subUrl} placeholder="https://example.com/calendar.ics" class="input w-full text-sm" />
							<input type="text" bind:value={subName} placeholder="Display name (e.g. UK Holidays)" class="input w-full text-sm" />
							<div class="flex items-center gap-2">
								<label class="text-sm text-surface-700-300">Colour</label>
								<input type="color" bind:value={subColor} class="size-7 cursor-pointer rounded border border-surface-200-800 p-0" />
							</div>
							<div class="flex gap-2">
								<button onclick={handleAddSubscription} disabled={isLoading || !subUrl || !subName}
									class="btn preset-filled-primary-500 flex-1 py-1.5 text-sm">{isLoading ? "Adding…" : "Subscribe"}</button>
								<button onclick={() => { mode = "view"; }} class="btn preset-ghost px-3 py-1.5 text-sm">Cancel</button>
							</div>
						</div>

					{:else if selectedAccount?.accountType === "subscription"}
						<div class="space-y-4">
							<div class="flex items-center justify-between">
								<h3 class="font-medium text-surface-900-100">{selectedAccount.name}</h3>
								<button onclick={() => handleDeleteAccount(selectedAccount.id)} class="text-xs text-error-500 hover:underline">Remove</button>
							</div>
							<div class="space-y-1">
								<p class="text-xs font-medium text-surface-500-400">Feed URL</p>
								<p class="text-xs text-surface-700-300 break-all">{selectedAccount.serverUrl}</p>
							</div>
							{#each accountCalendars as cal (cal.id)}
								<div class="flex items-center gap-3 rounded-lg border border-surface-200-800 px-3 py-2">
									<input type="checkbox" checked={cal.enabled}
										onchange={(e) => handleToggleCalendar(cal.id, (e.target as HTMLInputElement).checked)}
										class="checkbox" />
									<input type="color" value={cal.color}
										onchange={(e) => handleColorChange(cal.id, (e.target as HTMLInputElement).value)}
										class="size-6 cursor-pointer rounded border-0 p-0" />
									<span class="flex-1 text-sm truncate">{cal.name}</span>
									<span class="text-[10px] text-surface-400-600 shrink-0">Read-only</span>
								</div>
							{/each}
						</div>

					{:else}
						<p class="text-sm text-surface-500-400">Select an account from the list.</p>
					{/if}

				</div>
			</div>
		{/if}
	</div>
</div>
