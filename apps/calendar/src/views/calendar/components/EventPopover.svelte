<script lang="ts">
	import { onMount } from "svelte";
	import type { EventInstance, RecurringEditScope } from "../lib/types.ts";
	import { formatLongDate, formatTimeRange, parseISO } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";

	interface Props {
		instance: EventInstance;
		anchor: DOMRect;
		displayTzid: string;
		onEdit: () => void;
		onDelete: (scope: RecurringEditScope, instanceStartISO?: string) => void;
		onClose: () => void;
	}

	let { instance, anchor, displayTzid, onEdit, onDelete, onClose }: Props = $props();

	let popoverEl = $state<HTMLElement | null>(null);
	let showDeleteConfirm = $state(false);
	let detail = $state<{ description: string; location: string; url: string } | null>(null);
	let travelInfo = $state<{ minutes: number; originLat: number; originLon: number; destLat: number; destLon: number } | null>(null);
	let travelLoading = $state(false);

	// Derive the best meeting URL: explicit url field, then scan location/description
	const meetingUrl = $derived.by(() => {
		if (!detail) return null;
		if (detail.url) return detail.url;
		return extractMeetingUrl(detail.location, detail.description);
	});

	// Location is address-like if non-empty and not a URL (URLs are shown as meeting links)
	const addressLocation = $derived.by(() => {
		const loc = detail?.location ?? "";
		if (!loc.trim()) return null;
		if (/^https?:\/\//i.test(loc)) return null;
		return loc;
	});

	const mapSearchUrl = $derived(
		addressLocation
			? `https://www.openstreetmap.org/search?query=${encodeURIComponent(addressLocation)}`
			: null,
	);

	const osmDirectionsUrl = $derived.by(() => {
		if (!travelInfo || !addressLocation) return null;
		const { originLat, originLon, destLat, destLon } = travelInfo;
		return `https://www.openstreetmap.org/directions?from=${originLat}%2C${originLon}&to=${destLat}%2C${destLon}&engine=fossgis_osrm_car`;
	});

	/** Scan a string for known meeting service URLs */
	function extractMeetingUrl(...sources: string[]): string | null {
		const patterns = [
			/https?:\/\/[^\s]*\.zoom\.us\/j\/[^\s]*/,
			/https?:\/\/meet\.google\.com\/[a-z0-9-]+/i,
			/https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s]*/,
			/https?:\/\/teams\.live\.com\/meet\/[^\s]*/,
			/https?:\/\/[^\s]*\.webex\.com\/[^\s]*/,
			/https?:\/\/whereby\.com\/[^\s]*/,
			/https?:\/\/gotomeet\.me\/[^\s]*/,
			/https?:\/\/bluejeans\.com\/[^\s]*/,
		];
		for (const src of sources) {
			for (const re of patterns) {
				const m = src.match(re);
				if (m) return m[0].replace(/[,;>)\]"']+$/, ""); // trim trailing punctuation
			}
		}
		return null;
	}

	// Position popover near anchor, constrained to viewport
	const position = $derived.by(() => {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pw = 280; // estimated popover width
		const ph = 300; // estimated popover height

		let left = anchor.right + 8;
		let top = anchor.top;

		if (left + pw > vw - 16) left = anchor.left - pw - 8;
		if (top + ph > vh - 16) top = vh - ph - 16;
		if (left < 16) left = 16;
		if (top < 16) top = 16;

		return { left, top };
	});

	function handleDelete() {
		if (instance.hasRRule) {
			showDeleteConfirm = true;
		} else {
			onDelete("all");
		}
	}

	async function joinMeeting() {
		if (meetingUrl) {
			await rpc.request.openExternal({ url: meetingUrl });
		}
	}

	async function openMap() {
		if (mapSearchUrl) {
			await rpc.request.openExternal({ url: mapSearchUrl });
		}
	}

	async function openDirections() {
		if (osmDirectionsUrl) {
			await rpc.request.openExternal({ url: osmDirectionsUrl });
		}
	}

	onMount(async () => {
		function handleClickOutside(e: MouseEvent) {
			if (popoverEl && !popoverEl.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);

		// Load detail (description, location, url) from ICS
		try {
			detail = await rpc.request.getEventDetail({ uid: instance.uid });
		} catch {
			detail = { description: "", location: "", url: "" };
		}

		// Fetch travel info if location is address-like
		const loc = detail?.location ?? "";
		if (loc.trim() && !/^https?:\/\//i.test(loc)) {
			travelLoading = true;
			try {
				travelInfo = await rpc.request.getTravelInfo({ address: loc });
			} catch {
				travelInfo = null;
			}
			travelLoading = false;
		}

		return () => document.removeEventListener("mousedown", handleClickOutside);
	});
</script>

<!-- Backdrop -->
<div class="fixed inset-0 z-40" onclick={onClose} role="dialog" aria-modal="true" />

<!-- Popover -->
<div
	bind:this={popoverEl}
	class="fixed z-50 w-72 rounded-xl border border-surface-200-800 bg-surface-50-950 shadow-xl p-4"
	style="left: {position.left}px; top: {position.top}px;"
>
	<!-- Color bar + title -->
	<div class="flex items-start gap-3 mb-3">
		<div class="mt-0.5 size-3 shrink-0 rounded-full" style="background-color: {instance.color};" />
		<div class="flex-1 min-w-0">
			<h3 class="font-semibold text-surface-900-100 leading-tight">{instance.summary}</h3>
			{#if instance.status === "CANCELLED"}
				<span class="text-xs text-error-500 font-medium">Cancelled</span>
			{/if}
		</div>
		<button onclick={onClose} class="p-0.5 rounded hover:bg-surface-200-800 text-surface-500-400">
			<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
				<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
			</svg>
		</button>
	</div>

	<!-- Join meeting button (shown prominently when meeting link exists) -->
	{#if meetingUrl}
		<button
			onclick={joinMeeting}
			class="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-success-500 px-3 py-2 text-sm font-semibold text-white hover:bg-success-600 active:bg-success-700"
		>
			<svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
				<path d="M3.25 4A2.25 2.25 0 0 0 1 6.25v7.5A2.25 2.25 0 0 0 3.25 16h7.5A2.25 2.25 0 0 0 13 13.75v-1.56l3.22 2.56A.75.75 0 0 0 17.5 14V6a.75.75 0 0 0-1.28-.53L13 8.06V6.25A2.25 2.25 0 0 0 10.75 4h-7.5Z"/>
			</svg>
			Join meeting
		</button>
	{/if}

	<!-- View on map button (shown when location is an address, not a URL) -->
	{#if addressLocation}
		<button
			onclick={openMap}
			class="mb-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary-500 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-600 active:bg-primary-700"
		>
			<svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="m9.69 18.933.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 0 0 .281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.273 1.765 11.842 11.842 0 0 0 .976.544l.062.029.018.008.006.003ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" clip-rule="evenodd"/>
			</svg>
			View on map
		</button>
		<!-- Travel time (shown once loaded, as a clickable directions link) -->
		{#if travelLoading}
			<div class="mb-3 flex items-center gap-2 text-xs text-surface-500-400">
				<svg class="size-4 shrink-0 animate-spin" viewBox="0 0 20 20" fill="currentColor">
					<path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/>
				</svg>
				<span>Estimating travel time…</span>
			</div>
		{:else if travelInfo}
			<button
				onclick={openDirections}
				class="mb-3 flex w-full items-center justify-center gap-2 rounded-lg border border-surface-200-800 px-3 py-2 text-sm text-surface-700-300 hover:bg-surface-100-900"
			>
				<svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
					<path d="M6.3 2.84A1.5 1.5 0 0 1 8.5 4.11V6h1.5a3 3 0 0 1 3 3H15a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0V9a1 1 0 0 0-1-1H8.5v1.89a1.5 1.5 0 0 1-2.2 1.27l-3-1.89a1.5 1.5 0 0 1 0-2.54l3-1.89Z"/>
				</svg>
				~{travelInfo.minutes} min drive
			</button>
		{/if}
	{/if}

	<!-- Date/time -->
	<div class="mb-2 flex items-center gap-2 text-sm text-surface-700-300">
		<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" clip-rule="evenodd"/>
		</svg>
		<span>
			{#if instance.isAllDay}
				{formatLongDate(parseISO(instance.startISO))}
			{:else}
				{formatLongDate(parseISO(instance.startISO))}, {formatTimeRange(instance.startISO, instance.endISO, displayTzid)}
			{/if}
		</span>
	</div>

	{#if addressLocation}
		<div class="mb-2 flex items-center gap-2 text-sm text-surface-700-300">
			<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="m9.69 18.933.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 0 0 .281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.273 1.765 11.842 11.842 0 0 0 .976.544l.062.029.018.008.006.003ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" clip-rule="evenodd"/>
			</svg>
			<span class="truncate">{addressLocation}</span>
		</div>
	{/if}

	{#if instance.hasRRule}
		<div class="mb-2 flex items-center gap-2 text-xs text-surface-500-400">
			<svg class="size-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="M15.312 11.424a5.5 5.5 0 0 1-9.201 2.466l-.312-.311h2.433a.75.75 0 0 0 0-1.5H3.989a.75.75 0 0 0-.75.75v4.242a.75.75 0 0 0 1.5 0v-2.43l.31.31a7 7 0 0 0 11.712-3.138.75.75 0 0 0-1.449-.39Zm1.23-3.723a.75.75 0 0 0 .219-.53V2.929a.75.75 0 0 0-1.5 0V5.36l-.31-.31A7 7 0 0 0 3.239 8.188a.75.75 0 1 0 1.448.389A5.5 5.5 0 0 1 13.89 6.11l.311.31h-2.432a.75.75 0 0 0 0 1.5h4.243a.75.75 0 0 0 .53-.219Z" clip-rule="evenodd"/>
			</svg>
			<span>Recurring event</span>
		</div>
	{/if}

	<!-- Actions -->
	{#if !showDeleteConfirm}
		<div class="mt-3 flex gap-2">
			<button onclick={onEdit} class="btn preset-tonal flex-1 py-1.5 text-sm">Edit</button>
			<button onclick={handleDelete} class="btn preset-ghost py-1.5 text-sm text-error-500 hover:bg-error-50">Delete</button>
		</div>
	{:else}
		<!-- Recurring delete scope -->
		<div class="mt-3 space-y-2">
			<p class="text-xs font-medium text-surface-700-300">Delete recurring event:</p>
			<div class="space-y-1">
				<button onclick={() => onDelete("this", instance.startISO)} class="w-full rounded-lg border border-surface-200-800 px-3 py-2 text-left text-sm hover:bg-surface-100-900">
					This event only
				</button>
				<button onclick={() => onDelete("thisAndFollowing", instance.startISO)} class="w-full rounded-lg border border-surface-200-800 px-3 py-2 text-left text-sm hover:bg-surface-100-900">
					This and following events
				</button>
				<button onclick={() => onDelete("all")} class="w-full rounded-lg border border-surface-200-800 px-3 py-2 text-left text-sm text-error-600 hover:bg-error-50">
					All events
				</button>
			</div>
			<button onclick={() => { showDeleteConfirm = false; }} class="text-xs text-surface-500-400 hover:underline">
				Cancel
			</button>
		</div>
	{/if}
</div>
