<script lang="ts">
	import type { EventInstance } from "../lib/types.ts";
	import {
		toDateStr, getDateOf, minutesFromMidnight, eventDurationMinutes, formatTime, getISOWeekNumber,
	} from "../lib/types.ts";

	interface Props {
		instances: EventInstance[];
		navDate: Date;
		displayTzid: string;
		dayStart: number;
		dayEnd: number;
		focusedInstanceId?: string | null;
		onEventClick: (instance: EventInstance, anchor: DOMRect) => void;
		onEventDblClick: (instance: EventInstance) => void;
		onWeekClick: (date: string) => void;
		onSlotClick: (dateISO: string) => void;
		onDrop: (uid: string, instanceStartISO: string, newStartISO: string) => void;
	}

	let { instances, navDate, displayTzid, dayStart, dayEnd, focusedInstanceId, onEventClick, onEventDblClick, onWeekClick, onSlotClick, onDrop }: Props = $props();

	let _clickTimer: ReturnType<typeof setTimeout> | null = null;

	function handleEventClick(inst: EventInstance, e: MouseEvent) {
		e.stopPropagation();
		if (_clickTimer !== null) {
			clearTimeout(_clickTimer);
			_clickTimer = null;
			onEventDblClick(inst);
		} else {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			_clickTimer = setTimeout(() => { _clickTimer = null; onEventClick(inst, rect); }, 300);
		}
	}

	const HOUR_HEIGHT = 60;
	const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
	const SNAP_MINUTES = 15;

	const dateStr = $derived(toDateStr(navDate));

	const dayInstances = $derived(instances.filter((i) => !i.isAllDay && getDateOf(i.startISO) === dateStr));
	const allDayInstances = $derived(instances.filter((i) => i.isAllDay && getDateOf(i.startISO) === dateStr));

	// Compute columns for overlapping events
	function computeColumns(evs: EventInstance[]): Map<string, { col: number; cols: number }> {
		const layout = new Map<string, { col: number; cols: number }>();
		const sorted = [...evs].sort((a, b) => a.startISO.localeCompare(b.startISO));
		const columns: EventInstance[][] = [];
		for (const inst of sorted) {
			const startMin = minutesFromMidnight(inst.startISO, displayTzid);
			let placed = false;
			for (let ci = 0; ci < columns.length; ci++) {
				const col = columns[ci];
				const last = col[col.length - 1];
				if (minutesFromMidnight(last.endISO, displayTzid) <= startMin) {
					col.push(inst);
					layout.set(inst.instanceId, { col: ci, cols: 0 });
					placed = true;
					break;
				}
			}
			if (!placed) {
				columns.push([inst]);
				layout.set(inst.instanceId, { col: columns.length - 1, cols: 0 });
			}
		}
		for (const [id, pos] of layout) {
			layout.set(id, { col: pos.col, cols: columns.length });
		}
		return layout;
	}

	const layout = $derived(computeColumns(dayInstances));

	let gridEl = $state<HTMLElement | null>(null);
	let dragInst = $state<EventInstance | null>(null);

	// Scroll to dayStart when grid is ready or dayStart changes
	$effect(() => {
		if (gridEl) {
			gridEl.scrollTop = (dayStart / 24) * TOTAL_HEIGHT;
		}
	});

	function handleGridDrop(e: DragEvent) {
		e.preventDefault();
		if (!dragInst || !gridEl) return;
		const rect = gridEl.getBoundingClientRect();
		const relY = e.clientY - rect.top + gridEl.scrollTop;
		const minutes = Math.round((relY / TOTAL_HEIGHT) * 1440 / SNAP_MINUTES) * SNAP_MINUTES;
		const clamped = Math.max(0, Math.min(1439, minutes));
		const pad = (n: number) => String(n).padStart(2, "0");
		const h = Math.floor(clamped / 60), m = clamped % 60;
		const newStartISO = `${dateStr}T${pad(h)}:${pad(m)}:00`;
		onDrop(dragInst.uid, dragInst.startISO, newStartISO);
		dragInst = null;
	}
</script>

<div class="flex flex-1 flex-col overflow-hidden select-none">
	<!-- Non-scrolling top section: day header + optional all-day row -->
	<div class="shrink-0">
		<div class="flex border-b border-surface-200-800">
			<div class="w-14 shrink-0 flex items-end justify-center pb-1">
				<button
					onclick={() => onWeekClick(toDateStr(navDate))}
					class="text-xs font-medium text-surface-400-600 hover:text-surface-700-300 cursor-pointer"
					title="Show week"
				>W{getISOWeekNumber(navDate)}</button>
			</div>
			<div class="flex-1 border-l border-surface-200-800 py-2 text-center">
				<div class="text-xs text-surface-500-400">
					{navDate.toLocaleDateString("en-US", { weekday: "long" })}
				</div>
				<div class="text-lg font-semibold text-surface-900-100">{navDate.getDate()}</div>
			</div>
		</div>

		{#if allDayInstances.length > 0}
			<div class="flex border-b border-surface-200-800">
				<div class="w-14 shrink-0 flex items-center justify-end pr-2">
					<span class="text-xs text-surface-500-400">all-day</span>
				</div>
				<div class="flex-1 border-l border-surface-200-800 py-0.5 px-1">
					{#each allDayInstances as inst (inst.instanceId)}
						<button
							onclick={(e) => handleEventClick(inst, e)}
							data-instance-id={inst.instanceId}
							class="mb-0.5 block w-full truncate rounded px-2 py-1 text-left text-sm text-white font-medium hover:opacity-80
								{focusedInstanceId === inst.instanceId ? 'ring-2 ring-white' : ''}"
							style="background-color: {inst.color};"
						>{inst.summary}</button>
					{/each}
				</div>
			</div>
		{/if}
	</div>

	<!-- Scrollable time grid: flex-1 fills remaining height, overflow-y-auto enables scroll -->
	<div class="flex-1 overflow-y-auto" bind:this={gridEl}>
		<div class="flex" style="height: {TOTAL_HEIGHT}px; position: relative;">
			<!-- Time gutter -->
			<div class="w-14 shrink-0 relative">
				{#each Array.from({ length: 24 }, (_, h) => h) as hour}
					<div class="absolute right-2 text-xs text-surface-400-600" style="top: {hour * HOUR_HEIGHT - 6}px;">
						{#if hour > 0}{String(hour).padStart(2, "0")}:00{/if}
					</div>
				{/each}
			</div>

			<!-- Single day column -->
			<div
				class="flex-1 border-l border-surface-200-800 relative"
				ondragover={(e) => e.preventDefault()}
				ondrop={handleGridDrop}
				onclick={(e) => {
					const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
					const relY = e.clientY - rect.top;
					const minutes = Math.floor((relY / TOTAL_HEIGHT) * 1440 / SNAP_MINUTES) * SNAP_MINUTES;
					const h = Math.floor(minutes / 60), m = minutes % 60;
					const pad = (n: number) => String(n).padStart(2, "0");
					if ((e.target as HTMLElement).closest("button")) return;
					onSlotClick(`${dateStr}T${pad(h)}:${pad(m)}:00`);
				}}
				role="gridcell"
			>
				<!-- Off-hours shading -->
				{#if dayStart > 0}
					<div class="absolute left-0 right-0 pointer-events-none bg-surface-200-800/40"
						style="top: 0; height: {dayStart * HOUR_HEIGHT}px;" />
				{/if}
				{#if dayEnd < 24}
					<div class="absolute left-0 right-0 pointer-events-none bg-surface-200-800/40"
						style="top: {dayEnd * HOUR_HEIGHT}px; bottom: 0;" />
				{/if}

				{#each Array.from({ length: 24 }, (_, h) => h) as hour}
					<div class="absolute left-0 right-0 border-t border-surface-100-900" style="top: {hour * HOUR_HEIGHT}px;" />
				{/each}

				{#each dayInstances as inst (inst.instanceId)}
					{@const startMin = minutesFromMidnight(inst.startISO, displayTzid)}
					{@const durMin = Math.max(30, eventDurationMinutes(inst))}
					{@const pos = layout.get(inst.instanceId) ?? { col: 0, cols: 1 }}
					{@const top = (startMin / 1440) * TOTAL_HEIGHT}
					{@const height = (durMin / 1440) * TOTAL_HEIGHT}

					<button
						draggable="true"
						ondragstart={(e) => { e.stopPropagation(); dragInst = inst; e.dataTransfer!.effectAllowed = "move"; }}
						onclick={(e) => handleEventClick(inst, e)}
						data-instance-id={inst.instanceId}
						class="absolute rounded px-2 py-0.5 text-left text-sm text-white overflow-hidden hover:opacity-90 transition-opacity cursor-pointer
							{focusedInstanceId === inst.instanceId ? 'ring-2 ring-white ring-inset' : ''}"
						style="
							top: {top}px;
							height: {Math.max(height, 24)}px;
							width: calc({(1 / pos.cols) * 100}% - 4px);
							left: calc({(pos.col / pos.cols) * 100}% + 2px);
							background-color: {inst.color};
							z-index: 10;
						"
					>
						<div class="font-medium truncate">{inst.summary}</div>
						{#if height > 36}
							<div class="text-xs opacity-80">{formatTime(inst.startISO, displayTzid)} – {formatTime(inst.endISO, displayTzid)}</div>
						{/if}
					</button>
				{/each}
			</div>
		</div>
	</div>
</div>
