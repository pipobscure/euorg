<script lang="ts">
	import type { ViewMode } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";
	import {
		getMondayOf, addDays, formatMonth, formatShortDate, formatLongDate, COMMON_TIMEZONES,
	} from "../lib/types.ts";

	interface Props {
		viewMode: ViewMode;
		navDate: Date;
		displayTzid: string;
		isSyncing: boolean;
		onViewChange: (v: ViewMode) => void;
		onNavigate: (dir: -1 | 1) => void;
		onToday: () => void;
		onTzChange: (tz: string) => void;
		onNewEvent: () => void;
		onSync: () => void;
		onSettings: () => void;
		onSearchResult: (uid: string, dtstartUtc: string) => void;
		focusSearchTrigger?: number;
	}

	let {
		viewMode, navDate, displayTzid, isSyncing,
		onViewChange, onNavigate, onToday, onTzChange, onNewEvent, onSync, onSettings, onSearchResult,
		focusSearchTrigger,
	}: Props = $props();

	$effect(() => {
		if (focusSearchTrigger) searchEl?.focus();
	});

	// ── Event search ─────────────────────────────────────────────────────────
	let searchQuery = $state("");
	let searchResults = $state<Array<{ uid: string; recurrenceId: string | null; summary: string; dtstartUtc: string; calendarId: string; color: string; calendarName: string }>>([]);
	let searchOpen = $state(false);
	let searchEl = $state<HTMLInputElement | null>(null);

	async function handleSearchInput(e: Event) {
		const q = (e.target as HTMLInputElement).value.trim();
		searchQuery = (e.target as HTMLInputElement).value;
		if (q.length < 2) { searchResults = []; searchOpen = false; return; }
		try {
			const results = await rpc.request.searchEvents({ query: q });
			searchResults = results;
			searchOpen = results.length > 0;
		} catch { searchResults = []; searchOpen = false; }
	}

	function selectSearchResult(r: typeof searchResults[0]) {
		onSearchResult(r.uid, r.dtstartUtc);
		searchQuery = "";
		searchResults = [];
		searchOpen = false;
	}

	function formatSearchDate(utc: string): string {
		const d = new Date(utc);
		return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
	}

	const dateLabel = $derived.by(() => {
		if (viewMode === "day") return formatLongDate(navDate);
		if (viewMode === "week") {
			const monday = getMondayOf(navDate);
			const sunday = addDays(monday, 6);
			if (monday.getMonth() === sunday.getMonth()) {
				return `${monday.toLocaleDateString("en-US", { month: "short" })} ${monday.getDate()}–${sunday.getDate()}, ${monday.getFullYear()}`;
			}
			return `${formatShortDate(monday)} – ${formatShortDate(sunday)}, ${monday.getFullYear()}`;
		}
		return formatMonth(navDate);
	});

	// All IANA timezones (common first, rest after)
	const allTimezones: string[] = [
		...COMMON_TIMEZONES,
		...(typeof Intl !== "undefined" && "supportedValuesOf" in Intl
			? (Intl as any).supportedValuesOf("timeZone").filter((tz: string) => !COMMON_TIMEZONES.includes(tz))
			: []),
	];

	// Timezone combobox state
	let tzInput = $state(displayTzid);
	let tzOpen = $state(false);

	/** Convert a timezone ID to a human-readable display name.
	 *  e.g. "America/New_York" → "America / New York" */
	function tzIdToDisplay(tz: string): string {
		return tz.replace(/_/g, " ").replace(/\//g, " / ");
	}

	// Keep input in sync with prop when dropdown is closed
	$effect(() => {
		if (!tzOpen) tzInput = tzIdToDisplay(displayTzid);
	});

	const filteredTzList = $derived(
		tzInput === ""
			? allTimezones
			: allTimezones.filter((tz) => tzIdToDisplay(tz).toLowerCase().includes(tzInput.toLowerCase())),
	);

	function onTzFocus() {
		tzInput = ""; // clear so user can start typing immediately
		tzOpen = true;
	}

	function onTzBlur() {
		// Delay close so onmousedown on list items fires first
		setTimeout(() => { tzOpen = false; }, 150);
	}

	function selectTz(tz: string) {
		onTzChange(tz);
		tzInput = tzIdToDisplay(tz);
		tzOpen = false;
	}
</script>

<div class="flex h-12 items-center gap-2 px-3 select-none">
	<!-- New event -->
	<button
		onclick={onNewEvent}
		class="btn preset-filled-primary-500 flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium"
	>
		<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
			<path d="M10.75 4.75a.75.75 0 0 0-1.5 0v4.5h-4.5a.75.75 0 0 0 0 1.5h4.5v4.5a.75.75 0 0 0 1.5 0v-4.5h4.5a.75.75 0 0 0 0-1.5h-4.5v-4.5Z" />
		</svg>
		New Event
	</button>

	<div class="h-5 w-px bg-surface-200-800 mx-1" />

	<!-- Navigation -->
	<button
		onclick={onToday}
		class="btn preset-tonal px-3 py-1 text-sm"
	>Today</button>

	<button
		onclick={() => onNavigate(-1)}
		class="btn preset-ghost p-1.5"
		aria-label="Previous"
	>
		<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M11.78 5.22a.75.75 0 0 1 0 1.06L8.06 10l3.72 3.72a.75.75 0 1 1-1.06 1.06l-4.25-4.25a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd"/>
		</svg>
	</button>

	<span class="min-w-44 text-center text-sm font-semibold">{dateLabel}</span>

	<button
		onclick={() => onNavigate(1)}
		class="btn preset-ghost p-1.5"
		aria-label="Next"
	>
		<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M8.22 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L11.94 10 8.22 6.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/>
		</svg>
	</button>

	<!-- Search -->
	<div class="relative mx-2">
		<div class="flex items-center gap-1.5 rounded-lg border border-surface-200-800 bg-surface-100-900 px-2 py-1">
			<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd"/>
			</svg>
			<input
				bind:this={searchEl}
				type="text"
				value={searchQuery}
				oninput={handleSearchInput}
				onblur={() => setTimeout(() => { searchOpen = false; }, 150)}
				onfocus={() => { if (searchResults.length > 0) searchOpen = true; }}
				placeholder="Search events…"
				class="bg-transparent text-sm outline-none w-44 placeholder:text-surface-400-600"
			/>
			{#if searchQuery}
				<button
					type="button"
					onclick={() => { searchQuery = ''; searchResults = []; searchOpen = false; searchEl?.focus(); }}
					class="text-surface-400-600 hover:text-surface-700-300"
				>
					<svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor">
						<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
					</svg>
				</button>
			{/if}
		</div>
		{#if searchOpen && searchResults.length > 0}
			<ul class="absolute left-0 top-full z-50 mt-1 w-80 rounded-lg border border-surface-200-800 bg-surface-50-950 shadow-xl overflow-hidden">
				{#each searchResults as r}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-100-900"
							onmousedown={(e) => { e.preventDefault(); selectSearchResult(r); }}
						>
							<div class="size-2.5 shrink-0 rounded-full" style="background-color: {r.color};"></div>
							<div class="flex-1 min-w-0">
								<p class="truncate text-sm font-medium text-surface-900-100">{r.summary}</p>
								<p class="text-xs text-surface-500-400">{formatSearchDate(r.dtstartUtc)}{r.calendarName ? ' · ' + r.calendarName : ''}</p>
							</div>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="flex-1" />

	<!-- View mode selector -->
	<div class="flex rounded-lg overflow-hidden border border-surface-200-800">
		{#each (["day", "week", "month"] as ViewMode[]) as mode}
			<button
				onclick={() => onViewChange(mode)}
				class="px-3 py-1 text-sm capitalize transition-colors
					{viewMode === mode
						? 'bg-primary-500 text-white'
						: 'hover:bg-surface-100-900 text-surface-700-300'}"
			>{mode}</button>
		{/each}
	</div>

	<div class="h-5 w-px bg-surface-200-800 mx-1" />

	<!-- Timezone searchable combobox -->
	<div class="flex items-center gap-1.5">
		<svg class="size-4 text-surface-500-400 shrink-0" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7.5-4.5a.75.75 0 0 1 .75.75v3.19l1.97.98a.75.75 0 0 1-.67 1.34l-2.5-1.25A.75.75 0 0 1 9.75 10V6.25a.75.75 0 0 1 .75-.75Z" clip-rule="evenodd"/>
		</svg>
		<div class="relative">
			<input
				type="text"
				value={tzOpen ? tzInput : tzIdToDisplay(displayTzid)}
				oninput={(e) => { tzInput = (e.target as HTMLInputElement).value; }}
				onfocus={onTzFocus}
				onblur={onTzBlur}
				placeholder="Search timezone…"
				class="input text-xs py-1 px-2 w-44"
			/>
			{#if tzOpen}
				<div class="absolute right-0 top-full z-50 mt-1 max-h-60 w-64 overflow-y-auto rounded-lg border border-surface-200-800 bg-surface-50-950 shadow-lg">
					{#each filteredTzList as tz (tz)}
						<button
							type="button"
							class="block w-full px-3 py-1 text-left text-xs hover:bg-surface-100-900
								{tz === displayTzid ? 'text-primary-500 font-semibold' : ''}"
							onmousedown={() => selectTz(tz)}
						>{tzIdToDisplay(tz)}</button>
					{:else}
						<div class="px-3 py-2 text-xs text-surface-400-600">No results</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>

	<!-- Sync + Settings -->
	<button
		onclick={onSync}
		disabled={isSyncing}
		class="btn preset-ghost p-1.5 {isSyncing ? 'opacity-50' : ''}"
		aria-label="Sync"
	>
		<svg class="size-4 {isSyncing ? 'animate-spin' : ''}" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/>
		</svg>
	</button>

	<button onclick={onSettings} class="btn preset-ghost p-1.5" aria-label="Settings">
		<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" clip-rule="evenodd"/>
		</svg>
	</button>
</div>
