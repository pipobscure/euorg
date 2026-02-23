<script lang="ts">
	import { onMount } from "svelte";
	import type { EventInstance, CalendarView, EventInput, RecurringEditScope } from "../lib/types.ts";
	import { toDateStr, parseISO } from "../lib/types.ts";
	import { rpc } from "../lib/rpc.ts";
	import DatePicker from "./DatePicker.svelte";

	interface Props {
		instance: EventInstance | null; // null = new event
		defaultCalendarId: string;
		defaultDate: string;
		calendars: CalendarView[];
		displayTzid: string;
		onSave: (input: EventInput, scope: RecurringEditScope, instanceStartISO?: string) => void;
		onCancel: () => void;
		onDelete: (scope: RecurringEditScope, instanceStartISO?: string) => void;
	}

	let {
		instance, defaultCalendarId, defaultDate, calendars, displayTzid,
		onSave, onCancel, onDelete,
	}: Props = $props();

	// ── Recurring edit scope ─────────────────────────────────────────────────

	let editScope = $state<RecurringEditScope>("this");
	let showScopeSelector = $derived(instance?.hasRRule ?? false);
	let scopeConfirmed = $state(!instance?.hasRRule);

	// ── Form fields ──────────────────────────────────────────────────────────

	function defaultStart(): string {
		if (instance) return instance.startISO.slice(0, 16);
		return `${defaultDate}T09:00`;
	}

	function defaultEnd(): string {
		if (instance) return instance.endISO.slice(0, 16);
		return `${defaultDate}T10:00`;
	}

	let summary = $state(instance?.summary ?? "");
	let description = $state("");
	let location = $state("");
	let url = $state("");
	let isAllDay = $state(instance?.isAllDay ?? false);

	// Split date/time into separate fields for better UX
	const _defaultStart = defaultStart();
	const _defaultEnd = defaultEnd();
	let startDate = $state(_defaultStart.slice(0, 10));
	let startTime = $state(_defaultStart.slice(11, 16));
	let endDate = $state(_defaultEnd.slice(0, 10));
	let endTime = $state(_defaultEnd.slice(11, 16));
	let calendarId = $state(instance?.calendarId ?? defaultCalendarId);
	let rrulePreset = $state<string>(extractRrulePreset(instance));
	let customRrule = $state<string>("");
	let attendees = $state<Array<{ email: string; cn: string }>>([]);

	function extractRrulePreset(inst: EventInstance | null): string {
		if (!inst?.hasRRule) return "none";
		const rr = ""; // We'd need to load the full ICS to get the RRULE; default to custom
		return "custom";
	}

	const enabledCalendars = $derived(calendars.filter((c) => c.enabled && !c.readonly));

	function buildRrule(): string | undefined {
		switch (rrulePreset) {
			case "daily": return "FREQ=DAILY";
			case "weekly": {
				const d = parseISO(startDate);
				const days = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
				return `FREQ=WEEKLY;BYDAY=${days[d.getDay()]}`;
			}
			case "monthly": return "FREQ=MONTHLY";
			case "yearly": return "FREQ=YEARLY";
			case "custom": return customRrule || undefined;
			default: return undefined;
		}
	}

	function handleSave() {
		const input: EventInput = {
			uid: instance?.uid,
			calendarId,
			summary: summary.trim(),
			description: description.trim() || undefined,
			location: location.trim() || undefined,
			url: url.trim() || undefined,
			startISO: isAllDay ? startDate : `${startDate}T${startTime}:00`,
			endISO: isAllDay ? endDate : `${endDate}T${endTime}:00`,
			isAllDay,
			tzid: isAllDay ? undefined : displayTzid,
			rrule: buildRrule(),
			attendees: attendees.filter((a) => a.email).map((a) => ({ email: a.email, cn: a.cn })),
		};
		onSave(input, editScope, instance?.startISO);
	}

	function addAttendee() {
		attendees = [...attendees, { email: "", cn: "" }];
	}

	function removeAttendee(i: number) {
		attendees = attendees.filter((_, idx) => idx !== i);
	}

	// Load description, location, and url from ICS when editing an existing event
	onMount(async () => {
		if (instance) {
			try {
				const detail = await rpc.request.getEventDetail({ uid: instance.uid });
				if (detail) {
					description = detail.description;
					location = detail.location;
					url = detail.url;
				}
			} catch {
				// leave empty
			}
		}
	});
</script>

<!-- Modal backdrop -->
<div class="fixed inset-0 z-40 bg-black/40" onclick={onCancel} role="dialog" aria-modal="true" />

<!-- Modal -->
<div class="fixed inset-0 m-auto z-50 w-full max-w-lg h-fit rounded-2xl border border-surface-200-800 bg-surface-50-950 shadow-2xl">
	<!-- Header -->
	<div class="flex items-center justify-between border-b border-surface-200-800 px-6 py-4">
		<h2 class="text-base font-semibold text-surface-900-100">
			{instance ? "Edit Event" : "New Event"}
		</h2>
		<button onclick={onCancel} class="p-1 rounded-lg hover:bg-surface-100-900 text-surface-500-400">
			<svg class="size-5" viewBox="0 0 20 20" fill="currentColor">
				<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
			</svg>
		</button>
	</div>

	<!-- Recurring scope selector (shown first for existing recurring events) -->
	{#if showScopeSelector && !scopeConfirmed}
		<div class="px-6 py-6 space-y-3">
			<p class="text-sm font-medium text-surface-700-300">Edit recurring event:</p>
			{#each [
				{ value: "this" as RecurringEditScope, label: "This event only" },
				{ value: "thisAndFollowing" as RecurringEditScope, label: "This and following events" },
				{ value: "all" as RecurringEditScope, label: "All events" },
			] as opt}
				<label class="flex cursor-pointer items-center gap-3 rounded-xl border border-surface-200-800 p-3 hover:bg-surface-100-900">
					<input type="radio" bind:group={editScope} value={opt.value} class="accent-primary-500" />
					<span class="text-sm">{opt.label}</span>
				</label>
			{/each}
			<div class="flex gap-2 pt-2">
				<button onclick={() => { scopeConfirmed = true; }} class="btn preset-filled-primary-500 flex-1 py-2 text-sm">
					Continue
				</button>
				<button onclick={onCancel} class="btn preset-ghost flex-1 py-2 text-sm">Cancel</button>
			</div>
		</div>
	{:else}
		<!-- Form body -->
		<div class="max-h-[60vh] overflow-y-auto px-6 py-4 space-y-4">
			<!-- Title -->
			<div>
				<input
					type="text"
					bind:value={summary}
					placeholder="Event title"
					class="input w-full text-lg font-medium placeholder:font-normal"
					autofocus
				/>
			</div>

			<!-- Calendar -->
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">Calendar</label>
				<select bind:value={calendarId} class="input flex-1 text-sm py-1.5">
					{#each enabledCalendars as cal (cal.id)}
						<option value={cal.id}>{cal.name}</option>
					{/each}
				</select>
			</div>

			<!-- All-day toggle -->
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">All day</label>
				<input type="checkbox" bind:checked={isAllDay} class="checkbox" />
			</div>

			<!-- Date/time -->
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">Start</label>
				<DatePicker bind:value={startDate} class="flex-1" />
				{#if !isAllDay}
					<input type="time" bind:value={startTime} class="input text-sm py-1.5 w-28" />
				{/if}
			</div>
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">End</label>
				<DatePicker bind:value={endDate} class="flex-1" />
				{#if !isAllDay}
					<input type="time" bind:value={endTime} class="input text-sm py-1.5 w-28" />
				{/if}
			</div>

			<!-- Location -->
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">Location</label>
				<input type="text" bind:value={location} placeholder="Add location" class="input flex-1 text-sm py-1.5" />
			</div>

			<!-- Meeting URL -->
			<div class="flex items-center gap-3">
				<label class="w-20 shrink-0 text-sm text-surface-600-400">Meeting URL</label>
				<input type="url" bind:value={url} placeholder="https://zoom.us/j/… or meet.google.com/…" class="input flex-1 text-sm py-1.5" />
			</div>

			<!-- Recurrence -->
			<div class="flex items-start gap-3">
				<label class="w-20 shrink-0 pt-1.5 text-sm text-surface-600-400">Repeat</label>
				<div class="flex-1 space-y-2">
					<select bind:value={rrulePreset} class="input w-full text-sm py-1.5">
						<option value="none">Does not repeat</option>
						<option value="daily">Daily</option>
						<option value="weekly">Weekly on this day</option>
						<option value="monthly">Monthly</option>
						<option value="yearly">Yearly</option>
						<option value="custom">Custom...</option>
					</select>
					{#if rrulePreset === "custom"}
						<input
							type="text"
							bind:value={customRrule}
							placeholder="e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10"
							class="input w-full text-xs py-1.5 font-mono"
						/>
					{/if}
				</div>
			</div>

			<!-- Attendees -->
			<div class="space-y-2">
				<div class="flex items-center justify-between">
					<span class="text-sm text-surface-600-400">Attendees</span>
					<button onclick={addAttendee} class="text-xs text-primary-500 hover:underline">+ Add</button>
				</div>
				{#each attendees as att, i}
					<div class="flex items-center gap-2">
						<input type="email" bind:value={att.email} placeholder="email@example.com" class="input flex-1 text-sm py-1" />
						<input type="text" bind:value={att.cn} placeholder="Name (optional)" class="input w-32 text-sm py-1" />
						<button onclick={() => removeAttendee(i)} class="text-surface-400-600 hover:text-error-500">
							<svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
								<path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/>
							</svg>
						</button>
					</div>
				{/each}
			</div>

			<!-- Description -->
			<div>
				<textarea
					bind:value={description}
					placeholder="Add description"
					rows={3}
					class="input w-full resize-none text-sm"
				></textarea>
			</div>
		</div>

		<!-- Footer -->
		<div class="flex items-center justify-between border-t border-surface-200-800 px-6 py-4">
			<div>
				{#if instance}
					<button
						onclick={() => onDelete(editScope, instance?.startISO)}
						class="text-sm text-error-500 hover:underline"
					>Delete event</button>
				{/if}
			</div>
			<div class="flex gap-2">
				<button onclick={onCancel} class="btn preset-ghost px-4 py-2 text-sm">Cancel</button>
				<button onclick={handleSave} disabled={!summary.trim()} class="btn preset-filled-primary-500 px-4 py-2 text-sm">
					{instance ? "Save changes" : "Create event"}
				</button>
			</div>
		</div>
	{/if}
</div>
