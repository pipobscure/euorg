<script lang="ts">
	import type { CalendarView } from "../lib/types.ts";

	interface Props {
		icsText: string;
		calendars: CalendarView[];
		onImport: (icsText: string, calendarId: string) => void;
		onClose: () => void;
	}

	let { icsText, calendars, onImport, onClose }: Props = $props();

	const enabledCalendars = $derived(calendars.filter((c) => c.enabled));

	let selectedCalendarId = $state(enabledCalendars[0]?.id ?? "");

	// Parse a rough preview of events from the ICS text
	const eventPreviews = $derived.by(() => {
		const events: Array<{ summary: string; dtstart: string }> = [];
		const lines = icsText.split(/\r?\n/);
		let inEvent = false;
		let summary = "";
		let dtstart = "";
		for (const line of lines) {
			if (line === "BEGIN:VEVENT") { inEvent = true; summary = ""; dtstart = ""; }
			else if (line === "END:VEVENT") {
				if (inEvent) events.push({ summary: summary || "(No title)", dtstart });
				inEvent = false;
			} else if (inEvent) {
				if (line.startsWith("SUMMARY:")) summary = line.slice(8).replace(/\\n/g, " ").replace(/\\,/g, ",");
				else if (line.startsWith("DTSTART")) {
					const val = line.split(":").slice(1).join(":");
					// Format as date string for display
					if (val.length === 8) {
						dtstart = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
					} else if (val.length >= 15) {
						dtstart = `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)} ${val.slice(9, 11)}:${val.slice(11, 13)}`;
					} else {
						dtstart = val;
					}
				}
			}
		}
		return events;
	});
</script>

<!-- Backdrop -->
<div class="fixed inset-0 z-40 bg-black/40" onclick={onClose} role="dialog" aria-modal="true" />

<!-- Panel -->
<div class="fixed inset-x-0 bottom-0 z-50 flex max-h-[70vh] flex-col rounded-t-2xl border-t border-surface-200-800 bg-surface-50-950 shadow-2xl">
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-surface-200-800 px-5 py-4 shrink-0">
		<h2 class="text-base font-semibold text-surface-900-100">Import Calendar Events</h2>
		<button onclick={onClose} class="p-1 rounded-lg hover:bg-surface-100-900 text-surface-500-400">
			<svg class="size-5" viewBox="0 0 20 20" fill="currentColor">
				<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
			</svg>
		</button>
	</div>

	<!-- Content -->
	<div class="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
		<!-- Event count summary -->
		<p class="text-sm text-surface-600-400">
			{eventPreviews.length} event{eventPreviews.length !== 1 ? "s" : ""} found in the file.
		</p>

		<!-- Event list preview -->
		{#if eventPreviews.length > 0}
			<div class="rounded-lg border border-surface-200-800 overflow-hidden">
				{#each eventPreviews.slice(0, 20) as ev, i (i)}
					<div class="flex items-center gap-3 px-3 py-2 text-sm {i > 0 ? 'border-t border-surface-200-800' : ''}">
						<svg class="size-4 shrink-0 text-primary-500" viewBox="0 0 20 20" fill="currentColor">
							<path fill-rule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" clip-rule="evenodd"/>
						</svg>
						<span class="flex-1 truncate font-medium text-surface-900-100">{ev.summary}</span>
						{#if ev.dtstart}
							<span class="shrink-0 text-surface-500-400">{ev.dtstart}</span>
						{/if}
					</div>
				{/each}
				{#if eventPreviews.length > 20}
					<div class="border-t border-surface-200-800 px-3 py-2 text-sm text-surface-500-400">
						…and {eventPreviews.length - 20} more
					</div>
				{/if}
			</div>
		{/if}

		<!-- Target calendar selector -->
		<div class="flex items-center gap-3">
			<label class="text-sm font-medium text-surface-700-300 shrink-0">Import into:</label>
			<select bind:value={selectedCalendarId} class="select flex-1 text-sm">
				{#each enabledCalendars as cal (cal.id)}
					<option value={cal.id}>{cal.name}</option>
				{/each}
			</select>
		</div>

		{#if enabledCalendars.length === 0}
			<p class="text-sm text-error-500">No calendars available. Add a CalDAV account first.</p>
		{/if}
	</div>

	<!-- Footer buttons -->
	<div class="flex gap-2 border-t border-surface-200-800 px-5 py-3 shrink-0">
		<button onclick={onClose} class="btn preset-ghost px-4 py-2 text-sm">Cancel</button>
		<button
			onclick={() => onImport(icsText, selectedCalendarId)}
			disabled={!selectedCalendarId || eventPreviews.length === 0}
			class="btn preset-filled-primary-500 flex-1 py-2 text-sm"
		>
			Import {eventPreviews.length} event{eventPreviews.length !== 1 ? "s" : ""}
		</button>
	</div>
</div>
