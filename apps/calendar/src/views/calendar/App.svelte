<script lang="ts">
	import { onMount } from "svelte";
	import { rpc } from "./lib/rpc.ts";
	import type {
		EventInstance,
		CalendarView,
		AccountView,
		SyncProgress,
		SyncResult,
		ViewMode,
		EventInput,
		RecurringEditScope,
		CalendarPrefs,
	} from "./lib/types.ts";
	import {
		addDays, addWeeks, addMonths, getMondayOf, getWeekStart, getFirstOfMonth,
		toDateStr, formatMonth, formatLongDate, formatShortDate, parseISO,
		getLocaleWeekStart,
	} from "./lib/types.ts";

	import Toolbar from "./components/Toolbar.svelte";
	import CalendarList from "./components/CalendarList.svelte";
	import MonthView from "./components/MonthView.svelte";
	import WeekView from "./components/WeekView.svelte";
	import DayView from "./components/DayView.svelte";
	import EventPopover from "./components/EventPopover.svelte";
	import EventEditor from "./components/EventEditor.svelte";
	import AccountSettings from "./components/AccountSettings.svelte";
	import SyncStatus from "./components/SyncStatus.svelte";
	import ImportPanel from "./components/ImportPanel.svelte";

	// ── State ────────────────────────────────────────────────────────────────

	let prefs = $state<CalendarPrefs>({ startOfWeek: getLocaleWeekStart(), defaultView: "week", dayStart: 7, dayEnd: 22 });

	let viewMode = $state<ViewMode>("week");
	let navDate = $state<Date>(new Date());
	let displayTzid = $state<string>(Intl.DateTimeFormat().resolvedOptions().timeZone);
let searchFocusTrigger = $state(0);

	let instances = $state<EventInstance[]>([]);
	let calendars = $state<CalendarView[]>([]);
	let accounts = $state<AccountView[]>([]);

	let showEditor = $state(false);
	let editingInstance = $state<EventInstance | null>(null);
	let editorDefaultCalendarId = $state<string>("");
	let editorDefaultDate = $state<string>("");

	let showPopover = $state(false);
	let popoverInstance = $state<EventInstance | null>(null);
	let popoverAnchor = $state<DOMRect | null>(null);

	let focusedInstanceId = $state<string | null>(null);

	let showSettings = $state(false);
	let showImport = $state(false);
	let importIcsText = $state<string>("");

	let syncProgress = $state<SyncProgress | null>(null);
	let syncResult = $state<SyncResult | null>(null);
	let isSyncing = $state(false);

	let notification = $state<{ message: string; type: "success" | "error" } | null>(null);

	// ── Derived: range for current view ─────────────────────────────────────

	let rangeStart = $derived.by(() => {
		if (viewMode === "day") return toDateStr(navDate);
		if (viewMode === "week") return toDateStr(getWeekStart(navDate, prefs.startOfWeek));
		// Month: start from the week-start on or before month start
		const firstOfMonth = getFirstOfMonth(navDate.getFullYear(), navDate.getMonth());
		return toDateStr(getWeekStart(firstOfMonth, prefs.startOfWeek));
	});

	let rangeEnd = $derived.by(() => {
		if (viewMode === "day") return toDateStr(addDays(navDate, 1));
		if (viewMode === "week") return toDateStr(addDays(getWeekStart(navDate, prefs.startOfWeek), 7));
		// Month: 6 weeks
		const firstOfMonth = getFirstOfMonth(navDate.getFullYear(), navDate.getMonth());
		const gridStart = getWeekStart(firstOfMonth, prefs.startOfWeek);
		return toDateStr(addDays(gridStart, 42));
	});

	// ── Load instances when range changes ────────────────────────────────────

	let loadKey = $derived(`${rangeStart}|${rangeEnd}|${displayTzid}`);
	// Sequence counter: each loadInstances() call gets a unique seq.
	// Only the latest call's result is applied; stale concurrent responses are discarded.
	let loadSeq = 0;
	$effect(() => {
		// React to loadKey changes
		loadKey;
		loadInstances();
	});

	// Sorted instance list for keyboard event navigation
	const sortedInstances = $derived([...instances].sort((a, b) => a.startISO.localeCompare(b.startISO)));

	// Clear focus when the focused event is no longer in the loaded range
	$effect(() => {
		if (focusedInstanceId && !instances.find(i => i.instanceId === focusedInstanceId)) {
			focusedInstanceId = null;
		}
	});

	// Scroll focused event into view when focus moves
	$effect(() => {
		if (focusedInstanceId) {
			const el = document.querySelector(`[data-instance-id="${focusedInstanceId}"]`);
			el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		}
	});

	async function loadInstances() {
		const seq = ++loadSeq;
		try {
			const result = await rpc.request.getInstances({
				startISO: rangeStart,
				endISO: rangeEnd,
				displayTzid,
			});
			if (seq !== loadSeq) return; // stale response — a newer call already finished
			instances = result ?? [];
		} catch (e) {
			if (seq !== loadSeq) return;
			console.error("[calendar] getInstances failed:", e);
		}
	}

	async function loadCalendars() {
		try {
			calendars = (await rpc.request.getAllCalendars()) ?? [];
		} catch {}
	}

	async function loadAccounts() {
		try {
			accounts = (await rpc.request.getAccounts()) ?? [];
		} catch {}
	}

	// ── Navigation ───────────────────────────────────────────────────────────

	function navigate(dir: -1 | 1) {
		if (viewMode === "day") navDate = addDays(navDate, dir);
		else if (viewMode === "week") navDate = addWeeks(navDate, dir);
		else navDate = addMonths(navDate, dir);
	}

	function goToday() {
		navDate = new Date();
	}

	// ── Event CRUD ───────────────────────────────────────────────────────────

	function openNewEvent(defaultDate?: string) {
		editingInstance = null;
		editorDefaultDate = defaultDate ?? toDateStr(navDate);
		editorDefaultCalendarId = getDefaultCalendarId();
		showEditor = true;
		closePopover();
	}

	function openEditEvent(instance: EventInstance) {
		editingInstance = instance;
		editorDefaultCalendarId = instance.calendarId;
		showEditor = true;
		closePopover();
	}

	async function handleSaveEvent(input: EventInput, scope: RecurringEditScope, instanceStartISO?: string) {
		try {
			if (editingInstance) {
				await rpc.request.updateEvent({
					uid: editingInstance.uid,
					input,
					scope,
					instanceStartISO,
				});
				showNotification("Event updated");
			} else {
				await rpc.request.createEvent({ input });
				showNotification("Event created");
			}
			showEditor = false;
			navDate = parseISO(input.startISO);
			viewMode = "day";
			await loadInstances();
		} catch (e) {
			showNotification(e instanceof Error ? e.message : "Failed to save event", "error");
		}
	}

	async function handleDeleteEvent(uid: string, scope: RecurringEditScope, instanceStartISO?: string) {
		try {
			await rpc.request.deleteEvent({ uid, scope, instanceStartISO });
			showNotification("Event deleted");
			showEditor = false;
			closePopover();
			await loadInstances();
		} catch (e) {
			showNotification(e instanceof Error ? e.message : "Failed to delete event", "error");
		}
	}

	async function handleReschedule(uid: string, instanceStartISO: string, newStartISO: string) {
		try {
			await rpc.request.rescheduleEvent({ uid, instanceStartISO, newStartISO, scope: "this" });
			await loadInstances();
		} catch (e) {
			showNotification(e instanceof Error ? e.message : "Failed to reschedule event", "error");
			await loadInstances(); // reload to restore original position
		}
	}

	// ── Popover ──────────────────────────────────────────────────────────────

	function openPopover(instance: EventInstance, anchor: DOMRect) {
		popoverInstance = instance;
		popoverAnchor = anchor;
		showPopover = true;
	}

	function closePopover() {
		showPopover = false;
		popoverInstance = null;
		popoverAnchor = null;
	}

	// ── Sync ─────────────────────────────────────────────────────────────────

	async function triggerSync() {
		isSyncing = true;
		try {
			await rpc.request.triggerSync();
		} catch {}
	}

	// ── Calendar toggles ─────────────────────────────────────────────────────

	async function handleCalendarToggle(calendarId: string, enabled: boolean) {
		const cal = calendars.find((c) => c.id === calendarId);
		if (!cal) return;
		try {
			await rpc.request.setCalendarEnabled({ accountId: cal.accountId, calendarId, enabled });
			calendars = calendars.map((c) => (c.id === calendarId ? { ...c, enabled } : c));
			await loadInstances();
		} catch {}
	}

	// ── Import ───────────────────────────────────────────────────────────────

	async function handleImport(icsText: string, calendarId: string) {
		const defaultCal = getDefaultCalendarId();
		const targetCalendar = calendarId || defaultCal;
		if (!targetCalendar) return;
		const accountId = calendars.find((c) => c.id === targetCalendar)?.accountId ?? "";
		try {
			const result = await rpc.request.importIcs({ icsText, calendarId: targetCalendar, accountId });
			showNotification(`Imported ${result.imported} event(s)`);
			showImport = false;
			await loadInstances();
		} catch (e) {
			showNotification(e instanceof Error ? e.message : "Import failed", "error");
		}
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	function getDefaultCalendarId(): string {
		const enabledCals = calendars.filter((c) => c.enabled && !c.readonly);
		return enabledCals[0]?.id ?? "";
	}

	function showNotification(message: string, type: "success" | "error" = "success") {
		notification = { message, type };
		setTimeout(() => { notification = null; }, 3000);
	}

	// ── RPC message listeners ─────────────────────────────────────────────────

	rpc.addMessageListener("syncProgress", (p: SyncProgress) => {
		syncProgress = p;
		isSyncing = p.phase !== "done";
	});

	rpc.addMessageListener("syncComplete", (r: SyncResult) => {
		syncResult = r;
		isSyncing = false;
		syncProgress = null;
		loadInstances();
		if (r.errors.length > 0) {
			showNotification(`Sync complete with ${r.errors.length} error(s)`, "error");
		}
	});

	rpc.addMessageListener("eventChanged", async () => {
		await loadInstances();
	});

	rpc.addMessageListener("openImport", ({ icsText }: { icsText: string }) => {
		importIcsText = icsText;
		showImport = true;
	});

	// ── Init ──────────────────────────────────────────────────────────────────

	// ── Keyboard shortcuts ────────────────────────────────────────────────────

	function handleGlobalKeydown(e: KeyboardEvent) {
		// Only fire when no modal overlay is open
		if (showEditor || showSettings || showImport) return;
		// Don't intercept plain typing in inputs
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

		if (e.ctrlKey || e.metaKey) {
			switch (e.key) {
				case "n": e.preventDefault(); openNewEvent(); break;
				case ",": e.preventDefault(); showSettings = true; break;
				case "m": e.preventDefault(); viewMode = "month"; break;
				case "w": e.preventDefault(); viewMode = "week"; break;
				case "d": e.preventDefault(); viewMode = "day"; break;
				case "t": e.preventDefault(); goToday(); break;
				case "f": e.preventDefault(); searchFocusTrigger++; break;
			}
		} else {
			switch (e.key) {
				case "ArrowDown":
				case "ArrowRight": {
					if (sortedInstances.length === 0) break;
					e.preventDefault();
					closePopover();
					if (!focusedInstanceId) {
						focusedInstanceId = sortedInstances[0].instanceId;
					} else {
						const idx = sortedInstances.findIndex(i => i.instanceId === focusedInstanceId);
						focusedInstanceId = sortedInstances[idx === -1 || idx >= sortedInstances.length - 1 ? 0 : idx + 1].instanceId;
					}
					break;
				}
				case "ArrowUp":
				case "ArrowLeft": {
					if (sortedInstances.length === 0) break;
					e.preventDefault();
					closePopover();
					if (!focusedInstanceId) {
						focusedInstanceId = sortedInstances[sortedInstances.length - 1].instanceId;
					} else {
						const idx = sortedInstances.findIndex(i => i.instanceId === focusedInstanceId);
						focusedInstanceId = sortedInstances[idx <= 0 ? sortedInstances.length - 1 : idx - 1].instanceId;
					}
					break;
				}
				case " ": {
					if (!focusedInstanceId) break;
					e.preventDefault();
					if (showPopover && popoverInstance?.instanceId === focusedInstanceId) {
						closePopover();
					} else {
						const inst = instances.find(i => i.instanceId === focusedInstanceId);
						if (!inst) break;
						const el = document.querySelector(`[data-instance-id="${focusedInstanceId}"]`);
						if (el) openPopover(inst, el.getBoundingClientRect());
					}
					break;
				}
				case "Enter": {
					if (!focusedInstanceId || showPopover) break;
					e.preventDefault();
					const inst = instances.find(i => i.instanceId === focusedInstanceId);
					if (inst) openEditEvent(inst);
					break;
				}
				case "Escape": {
					if (showPopover) { closePopover(); break; }
					if (focusedInstanceId) { focusedInstanceId = null; }
					break;
				}
			}
		}
	}

	onMount(async () => {
		document.addEventListener("keydown", handleGlobalKeydown);

		await Promise.all([loadCalendars(), loadAccounts()]);
		const [tz, loadedPrefs] = await Promise.all([
			rpc.request.getDisplayTimezone(),
			rpc.request.getCalendarPrefs(),
		]);
		displayTzid = tz;
		prefs = {
			...loadedPrefs,
			// Resolve "locale" sentinel to the actual browser locale value
			startOfWeek: loadedPrefs.startOfWeek === "locale" ? getLocaleWeekStart() : loadedPrefs.startOfWeek,
		};
		viewMode = loadedPrefs.defaultView;
		// Trigger startup sync now that we know the RPC connection is live
		triggerSync();

		return () => document.removeEventListener("keydown", handleGlobalKeydown);
	});
</script>

<!-- Root: h-screen flex-col, same pattern as contacts app. SyncStatus always at bottom. -->
<div class="preset-filled-surface-50-950 flex h-screen flex-col overflow-hidden">
	<!-- Toolbar -->
	<header class="border-b border-surface-200-800 shrink-0">
		<Toolbar
			{viewMode}
			{navDate}
			{displayTzid}
			{isSyncing}
			onViewChange={(v) => { viewMode = v; }}
			onNavigate={(dir) => navigate(dir)}
			onToday={goToday}
			onTzChange={async (tz) => {
				displayTzid = tz;
				await rpc.request.setDisplayTimezone({ tzid: tz });
			}}
			onNewEvent={() => openNewEvent()}
			onSync={triggerSync}
			onSettings={() => { showSettings = true; }}
			focusSearchTrigger={searchFocusTrigger}
			onSearchResult={(uid, dtstartUtc) => {
				navDate = new Date(dtstartUtc);
				viewMode = "day";
			}}
		/>
	</header>

	<!-- Main row: sidebar + view area -->
	<div class="flex flex-1 overflow-hidden">
		<!-- Sidebar: flex-col so CalendarList can pin Account Settings button at bottom -->
		<aside class="shrink-0 border-r border-surface-200-800 flex flex-col overflow-hidden">
			<CalendarList
				{calendars}
				{accounts}
				onToggle={handleCalendarToggle}
				onSettingsClick={() => { showSettings = true; }}
			/>
		</aside>

		<!-- Calendar view area: flex-col, views fill this with flex-1 -->
		<div class="flex-1 flex flex-col overflow-hidden">
			{#if viewMode === "month"}
				<MonthView
					{instances}
					{navDate}
					{displayTzid}
					{calendars}
					startOfWeek={prefs.startOfWeek}
					{focusedInstanceId}
					onEventClick={openPopover}
					onEventDblClick={(inst) => { navDate = parseISO(inst.startISO); viewMode = "day"; }}
					onDayClick={(date) => openNewEvent(date)}
					onDayDblClick={(date) => { navDate = parseISO(date); viewMode = "day"; }}
					onWeekDblClick={(date) => { navDate = parseISO(date); viewMode = "week"; }}
					onDrop={async (instanceId, newDate) => {
						const inst = instances.find((i) => i.instanceId === instanceId);
						if (!inst) return;
						const origStart = inst.startISO;
						const newISO = newDate + origStart.slice(10);
						await handleReschedule(inst.uid, origStart, newISO);
					}}
				/>
			{:else if viewMode === "week"}
				<WeekView
					{instances}
					{navDate}
					{displayTzid}
					startOfWeek={prefs.startOfWeek}
					dayStart={prefs.dayStart}
					dayEnd={prefs.dayEnd}
					{focusedInstanceId}
					onEventClick={openPopover}
					onEventDblClick={(inst) => { navDate = parseISO(inst.startISO); viewMode = "day"; }}
					onDayDblClick={(date) => { navDate = parseISO(date); viewMode = "day"; }}
					onSlotClick={(dateISO) => openNewEvent(dateISO.slice(0, 10))}
					onDrop={handleReschedule}
				/>
			{:else}
				<DayView
					{instances}
					{navDate}
					{displayTzid}
					dayStart={prefs.dayStart}
					dayEnd={prefs.dayEnd}
					{focusedInstanceId}
					onEventClick={openPopover}
					onEventDblClick={openEditEvent}
					onWeekClick={(date) => { navDate = parseISO(date); viewMode = "week"; }}
					onSlotClick={(dateISO) => openNewEvent(dateISO.slice(0, 10))}
					onDrop={handleReschedule}
				/>
			{/if}
		</div>
	</div>

	<!-- Status bar: direct child of h-screen flex-col, always pinned at bottom -->
	<SyncStatus {syncProgress} {syncResult} {isSyncing} />
</div>

<!-- Overlays -->
{#if showPopover && popoverInstance && popoverAnchor}
	<EventPopover
		instance={popoverInstance}
		anchor={popoverAnchor}
		{displayTzid}
		{calendars}
		onEdit={() => openEditEvent(popoverInstance!)}
		onDelete={(scope, instanceStartISO) => handleDeleteEvent(popoverInstance!.uid, scope, instanceStartISO)}
		onClose={closePopover}
	/>
{/if}

{#if showEditor}
	<EventEditor
		instance={editingInstance}
		defaultCalendarId={editorDefaultCalendarId}
		defaultDate={editorDefaultDate}
		{calendars}
		{displayTzid}
		onSave={handleSaveEvent}
		onCancel={() => { showEditor = false; }}
		onDelete={(scope, instanceStartISO) => handleDeleteEvent(editingInstance!.uid, scope, instanceStartISO)}
	/>
{/if}

{#if showSettings}
	<AccountSettings
		{accounts}
		{calendars}
		{prefs}
		onPrefChange={(updated) => { prefs = updated; }}
		onAccountsChange={(updatedAccounts, updatedCalendars) => {
			accounts = updatedAccounts;
			calendars = updatedCalendars;
		}}
		onClose={async () => {
			showSettings = false;
			await Promise.all([loadCalendars(), loadAccounts()]);
		}}
	/>
{/if}

{#if showImport}
	<ImportPanel
		icsText={importIcsText}
		{calendars}
		onImport={handleImport}
		onClose={() => { showImport = false; }}
	/>
{/if}

<!-- Notification banner -->
{#if notification}
	<div
		class="fixed bottom-4 right-4 z-50 rounded-lg px-4 py-2 text-sm font-medium shadow-lg
			{notification.type === 'error'
				? 'bg-error-500 text-white'
				: 'bg-success-500 text-white'}"
	>
		{notification.message}
	</div>
{/if}
