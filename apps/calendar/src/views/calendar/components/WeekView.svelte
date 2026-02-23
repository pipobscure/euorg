<script lang="ts">
	import type { EventInstance } from "../lib/types.ts";
	import {
		getWeekStart, addDays, toDateStr, getDateOf, parseISO,
		minutesFromMidnight, eventDurationMinutes, formatTime, getISOWeekNumber,
	} from "../lib/types.ts";

	interface Props {
		instances: EventInstance[];
		navDate: Date;
		displayTzid: string;
		startOfWeek: "monday" | "sunday";
		dayStart: number;
		dayEnd: number;
		focusedInstanceId?: string | null;
		onEventClick: (instance: EventInstance, anchor: DOMRect) => void;
		onEventDblClick: (instance: EventInstance) => void;
		onDayDblClick: (date: string) => void;
		onSlotClick: (dateISO: string) => void;
		onDrop: (uid: string, instanceStartISO: string, newStartISO: string) => void;
	}

	let { instances, navDate, displayTzid, startOfWeek, dayStart, dayEnd, focusedInstanceId, onEventClick, onEventDblClick, onDayDblClick, onSlotClick, onDrop }: Props = $props();

	let _clickTimer: ReturnType<typeof setTimeout> | null = null;
	let _dayClickTimer: ReturnType<typeof setTimeout> | null = null;
	let _dayClickDate: string | null = null;

	function handleDayHeaderClick(dateStr: string) {
		if (_dayClickTimer !== null && _dayClickDate === dateStr) {
			clearTimeout(_dayClickTimer);
			_dayClickTimer = null;
			_dayClickDate = null;
			onDayDblClick(dateStr);
		} else {
			if (_dayClickTimer !== null) clearTimeout(_dayClickTimer);
			_dayClickDate = dateStr;
			_dayClickTimer = setTimeout(() => { _dayClickTimer = null; _dayClickDate = null; }, 300);
		}
	}

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


	const HOUR_HEIGHT = 60; // px per hour
	const TOTAL_HEIGHT = HOUR_HEIGHT * 24;
	const SNAP_MINUTES = 15;

	// 7 days of the week starting from configured start day
	const weekDays = $derived.by(() => {
		const start = getWeekStart(navDate, startOfWeek);
		return Array.from({ length: 7 }, (_, i) => addDays(start, i));
	});

	const today = toDateStr(new Date());

	// Separate single-day timed events from all-day / multi-day events.
	// Timed events spanning multiple calendar days go to the all-day row (like Google Calendar).
	const allDayInstances = $derived(instances.filter((i) =>
		i.isAllDay || getDateOf(i.startISO) !== getDateOf(i.endISO)
	));
	const timedInstances = $derived(instances.filter((i) =>
		!i.isAllDay && getDateOf(i.startISO) === getDateOf(i.endISO)
	));

	// Group timed (single-day) instances by day
	const instancesByDay = $derived.by(() => {
		const map = new Map<string, EventInstance[]>();
		for (const day of weekDays) {
			map.set(toDateStr(day), []);
		}
		for (const inst of timedInstances) {
			const dateStr = getDateOf(inst.startISO);
			const existing = map.get(dateStr);
			if (existing) existing.push(inst);
		}
		return map;
	});

	// Group all-day / multi-day instances — spanning events appear on every day they cover
	const allDayByDay = $derived.by(() => {
		const map = new Map<string, EventInstance[]>();
		for (const inst of allDayInstances) {
			const startStr = getDateOf(inst.startISO);
			const endStr = getDateOf(inst.endISO);
			for (const day of weekDays) {
				const dayStr = toDateStr(day);
				// All-day: endISO is exclusive. Timed multi-day: include the end date.
				const inRange = inst.isAllDay
					? (dayStr >= startStr && dayStr < endStr)
					: (dayStr >= startStr && dayStr <= endStr);
				if (inRange) {
					const existing = map.get(dayStr) ?? [];
					existing.push(inst);
					map.set(dayStr, existing);
				}
			}
		}
		return map;
	});

	// Compute layout columns for overlapping events
	function computeColumns(dayInstances: EventInstance[]): Map<string, { col: number; cols: number }> {
		const layout = new Map<string, { col: number; cols: number }>();
		const sorted = [...dayInstances].sort((a, b) => a.startISO.localeCompare(b.startISO));
		const columns: EventInstance[][] = [];

		for (const inst of sorted) {
			const startMin = minutesFromMidnight(inst.startISO, displayTzid);
			const durMin = eventDurationMinutes(inst);
			const endMin = startMin + durMin;

			let placed = false;
			for (let ci = 0; ci < columns.length; ci++) {
				const col = columns[ci];
				const lastInCol = col[col.length - 1];
				if (minutesFromMidnight(lastInCol.endISO, displayTzid) <= startMin) {
					col.push(inst);
					layout.set(inst.instanceId, { col: ci, cols: 0 }); // cols set below
					placed = true;
					break;
				}
			}
			if (!placed) {
				columns.push([inst]);
				layout.set(inst.instanceId, { col: columns.length - 1, cols: 0 });
			}
		}

		// Set total columns for each event
		for (const [id, pos] of layout) {
			layout.set(id, { col: pos.col, cols: columns.length });
		}
		return layout;
	}

	// Drag state
	let dragInst = $state<EventInstance | null>(null);
	let gridEl = $state<HTMLElement | null>(null);

	// Scroll to dayStart when grid is ready or dayStart changes
	$effect(() => {
		if (gridEl) {
			gridEl.scrollTop = (dayStart / 24) * TOTAL_HEIGHT;
		}
	});

	function handleDragStart(e: DragEvent, inst: EventInstance) {
		dragInst = inst;
		e.dataTransfer!.effectAllowed = "move";
	}

	function handleGridDrop(e: DragEvent, dayStr: string) {
		e.preventDefault();
		if (!dragInst || !gridEl) return;

		const rect = gridEl.getBoundingClientRect();
		const relY = e.clientY - rect.top + gridEl.scrollTop;
		const minutes = Math.round((relY / TOTAL_HEIGHT) * 1440 / SNAP_MINUTES) * SNAP_MINUTES;
		const clampedMinutes = Math.max(0, Math.min(1439, minutes));

		const pad = (n: number) => String(n).padStart(2, "0");
		const h = Math.floor(clampedMinutes / 60);
		const m = clampedMinutes % 60;
		const newStartISO = `${dayStr}T${pad(h)}:${pad(m)}:00`;

		onDrop(dragInst.uid, dragInst.startISO, newStartISO);
		dragInst = null;
	}
</script>

<div class="flex flex-1 flex-col overflow-hidden select-none">
	<!-- Non-scrolling top section: day headers + optional all-day row -->
	<div class="shrink-0">
		<div class="flex border-b border-surface-200-800">
			<div class="w-14 shrink-0 flex items-end justify-center pb-1">
				<span class="text-xs font-medium text-surface-400-600">W{getISOWeekNumber(weekDays[0])}</span>
			</div> <!-- time gutter -->
			{#each weekDays as day (toDateStr(day))}
				{@const dateStr = toDateStr(day)}
				{@const isToday = dateStr === today}
				<div class="flex-1 py-1 text-center cursor-pointer"
					onclick={() => handleDayHeaderClick(dateStr)}
				>
					<div class="text-xs text-surface-500-400">
						{day.toLocaleDateString("en-US", { weekday: "short" })}
					</div>
					<div class="flex items-center justify-center">
						<span
							class="flex size-7 items-center justify-center rounded-full text-sm font-semibold
								{isToday ? 'bg-primary-500 text-white' : 'text-surface-700-300'}"
						>{day.getDate()}</span>
					</div>
				</div>
			{/each}
		</div>

		{#if allDayInstances.length > 0}
			<div class="flex border-b border-surface-200-800">
				<div class="w-14 shrink-0 flex items-center justify-end pr-2">
					<span class="text-xs text-surface-500-400">all-day</span>
				</div>
				{#each weekDays as day (toDateStr(day))}
					{@const dayInstances = allDayByDay.get(toDateStr(day)) ?? []}
					<div class="flex-1 border-l border-surface-200-800 py-0.5 px-0.5 min-h-6">
						{#each dayInstances as inst (inst.instanceId)}
							<button
								onclick={(e) => handleEventClick(inst, e)}
								data-instance-id={inst.instanceId}
								class="mb-0.5 block w-full truncate rounded px-1 py-0.5 text-left text-xs text-white font-medium hover:opacity-80
									{focusedInstanceId === inst.instanceId ? 'ring-2 ring-white' : ''}"
								style="background-color: {inst.color};"
							>{inst.summary}</button>
						{/each}
					</div>
				{/each}
			</div>
		{/if}
	</div>

	<!-- Scrollable time grid: flex-1 fills remaining height, overflow-y-auto enables scroll -->
	<div class="flex-1 overflow-y-auto" bind:this={gridEl}>
		<div class="flex" style="height: {TOTAL_HEIGHT}px; position: relative;">
			<!-- Time gutter -->
			<div class="w-14 shrink-0 relative">
				{#each Array.from({ length: 24 }, (_, h) => h) as hour}
					<div
						class="absolute right-2 text-xs text-surface-400-600"
						style="top: {hour * HOUR_HEIGHT - 6}px;"
					>
						{#if hour > 0}{String(hour).padStart(2, "0")}:00{/if}
					</div>
				{/each}
			</div>

			<!-- Day columns -->
			{#each weekDays as day (toDateStr(day))}
				{@const dateStr = toDateStr(day)}
				{@const dayInstances = instancesByDay.get(dateStr) ?? []}
				{@const layout = computeColumns(dayInstances)}

				<div
					class="flex-1 border-l border-surface-200-800 relative"
					ondragover={(e) => e.preventDefault()}
					ondrop={(e) => handleGridDrop(e, dateStr)}
					onclick={(e) => {
						const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
						const relY = e.clientY - rect.top;
						const minutes = Math.floor((relY / TOTAL_HEIGHT) * 1440 / SNAP_MINUTES) * SNAP_MINUTES;
						const h = Math.floor(minutes / 60);
						const m = minutes % 60;
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

					<!-- Horizontal hour lines -->
					{#each Array.from({ length: 24 }, (_, h) => h) as hour}
						<div
							class="absolute left-0 right-0 border-t border-surface-100-900"
							style="top: {hour * HOUR_HEIGHT}px;"
						/>
					{/each}

					<!-- Events -->
					{#each dayInstances as inst (inst.instanceId)}
						{@const startMin = minutesFromMidnight(inst.startISO, displayTzid)}
						{@const durMin = Math.max(30, eventDurationMinutes(inst))}
						{@const pos = layout.get(inst.instanceId) ?? { col: 0, cols: 1 }}
						{@const top = (startMin / 1440) * TOTAL_HEIGHT}
						{@const height = (durMin / 1440) * TOTAL_HEIGHT}
						{@const width = `calc(${(1 / pos.cols) * 100}% - 2px)`}
						{@const left = `calc(${(pos.col / pos.cols) * 100}%)`}

						<button
							draggable="true"
							ondragstart={(e) => { e.stopPropagation(); handleDragStart(e, inst); }}
							onclick={(e) => handleEventClick(inst, e)}
							data-instance-id={inst.instanceId}
							class="absolute rounded px-1 py-0.5 text-left text-xs text-white overflow-hidden hover:opacity-90 transition-opacity cursor-pointer
								{focusedInstanceId === inst.instanceId ? 'ring-2 ring-white ring-inset' : ''}"
							style="
								top: {top}px;
								height: {Math.max(height, 20)}px;
								width: {width};
								left: {left};
								background-color: {inst.color};
								z-index: 10;
							"
						>
							<div class="font-medium truncate">{inst.summary}</div>
							{#if height > 30}
								<div class="opacity-80 truncate">{formatTime(inst.startISO, displayTzid)}–{formatTime(inst.endISO, displayTzid)}</div>
							{/if}
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</div>
</div>
