<script lang="ts">
	import { onMount } from "svelte";
	import type { EventInstance, RecurringEditScope } from "../lib/types.ts";
	import { formatLongDate, formatTimeRange, parseISO } from "../lib/types.ts";

	interface Props {
		instance: EventInstance;
		anchor: DOMRect;
		onEdit: () => void;
		onDelete: (scope: RecurringEditScope, instanceStartISO?: string) => void;
		onClose: () => void;
	}

	let { instance, anchor, onEdit, onDelete, onClose }: Props = $props();

	let popoverEl = $state<HTMLElement | null>(null);
	let showDeleteConfirm = $state(false);

	// Position popover near anchor, constrained to viewport
	const position = $derived.by(() => {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const pw = 280; // estimated popover width
		const ph = 220; // estimated popover height

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

	onMount(() => {
		function handleClickOutside(e: MouseEvent) {
			if (popoverEl && !popoverEl.contains(e.target as Node)) {
				onClose();
			}
		}
		document.addEventListener("mousedown", handleClickOutside);
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

	<!-- Date/time -->
	<div class="mb-2 flex items-center gap-2 text-sm text-surface-700-300">
		<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
			<path fill-rule="evenodd" d="M5.75 2a.75.75 0 0 1 .75.75V4h7V2.75a.75.75 0 0 1 1.5 0V4h.25A2.75 2.75 0 0 1 18 6.75v8.5A2.75 2.75 0 0 1 15.25 18H4.75A2.75 2.75 0 0 1 2 15.25v-8.5A2.75 2.75 0 0 1 4.75 4H5V2.75A.75.75 0 0 1 5.75 2Zm-1 5.5c-.69 0-1.25.56-1.25 1.25v6.5c0 .69.56 1.25 1.25 1.25h10.5c.69 0 1.25-.56 1.25-1.25v-6.5c0-.69-.56-1.25-1.25-1.25H4.75Z" clip-rule="evenodd"/>
		</svg>
		<span>
			{#if instance.isAllDay}
				{formatLongDate(parseISO(instance.startISO))}
			{:else}
				{formatLongDate(parseISO(instance.startISO))}, {formatTimeRange(instance.startISO, instance.endISO)}
			{/if}
		</span>
	</div>

	{#if instance.location}
		<div class="mb-2 flex items-center gap-2 text-sm text-surface-700-300">
			<svg class="size-4 shrink-0 text-surface-400-600" viewBox="0 0 20 20" fill="currentColor">
				<path fill-rule="evenodd" d="m9.69 18.933.003.001C9.89 19.02 10 19 10 19s.11.02.308-.066l.002-.001.006-.003.018-.008a5.741 5.741 0 0 0 .281-.14c.186-.096.446-.24.757-.433.62-.384 1.445-.966 2.274-1.765C15.302 14.988 17 12.493 17 9A7 7 0 1 0 3 9c0 3.492 1.698 5.988 3.355 7.584a13.731 13.731 0 0 0 2.273 1.765 11.842 11.842 0 0 0 .976.544l.062.029.018.008.006.003ZM10 11.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z" clip-rule="evenodd"/>
			</svg>
			<span class="truncate">{instance.location}</span>
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
				<button onclick={() => onDelete("all")} class="w-full rounded-lg border border-error-200 px-3 py-2 text-left text-sm text-error-600 hover:bg-error-50">
					All events
				</button>
			</div>
			<button onclick={() => { showDeleteConfirm = false; }} class="text-xs text-surface-500-400 hover:underline">
				Cancel
			</button>
		</div>
	{/if}
</div>
