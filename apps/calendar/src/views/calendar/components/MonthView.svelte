<script lang="ts">
	import type { EventInstance, CalendarView } from "../lib/types.ts";
	import {
		getWeekStart, addDays, getFirstOfMonth, toDateStr, getDateOf,
		formatTime, parseISO, getISOWeekNumber,
	} from "../lib/types.ts";

	interface Props {
		instances: EventInstance[];
		navDate: Date;
		displayTzid: string;
		calendars: CalendarView[];
		startOfWeek: "monday" | "sunday";
		onEventClick: (instance: EventInstance, anchor: DOMRect) => void;
		onEventDblClick: (instance: EventInstance) => void;
		onDayClick: (date: string) => void;
		onDayDblClick: (date: string) => void;
		onWeekDblClick: (date: string) => void;
		onDrop: (instanceId: string, newDate: string) => void;
	}

	let { instances, navDate, displayTzid, calendars, startOfWeek, onEventClick, onEventDblClick, onDayClick, onDayDblClick, onWeekDblClick, onDrop }: Props = $props();

	let _clickTimer: ReturnType<typeof setTimeout> | null = null;

	function handleEventClick(inst: EventInstance, e: MouseEvent) {
		e.stopPropagation();
		if (_clickTimer !== null) {
			clearTimeout(_clickTimer);
			_clickTimer = null;
			onEventDblClick(inst);
		} else {
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			_clickTimer = setTimeout(() => { _clickTimer = null; onEventClick(inst, rect); }, 250);
		}
	}


	const MAX_VISIBLE_EVENTS = 3;

	// Build 6-week grid starting from the configured week-start day on or before the 1st
	const grid = $derived.by(() => {
		const firstOfMonth = getFirstOfMonth(navDate.getFullYear(), navDate.getMonth());
		const gridStart = getWeekStart(firstOfMonth, startOfWeek);
		const days: Date[] = [];
		for (let i = 0; i < 42; i++) {
			days.push(addDays(gridStart, i));
		}
		return days;
	});

	// Chunk the flat 42-day grid into 6 rows of 7 for week-number rendering
	const weeks = $derived.by(() => {
		const rows: Date[][] = [];
		for (let i = 0; i < 6; i++) rows.push(grid.slice(i * 7, (i + 1) * 7));
		return rows;
	});

	const dayLabels = $derived(
		startOfWeek === "monday"
			? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
			: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
	);

	const currentMonthNum = $derived(navDate.getMonth());

	// Group instances by date — spanning events appear on every day they cover
	const instancesByDate = $derived.by(() => {
		const map = new Map<string, EventInstance[]>();
		for (const inst of instances) {
			const startStr = getDateOf(inst.startISO);
			const endStr = getDateOf(inst.endISO);
			for (const day of grid) {
				const dayStr = toDateStr(day);
				// All-day: endISO is exclusive (next day). Timed: include the end date.
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

	const today = toDateStr(new Date());

	// Drag state
	let dragInstanceId = $state<string | null>(null);
	let dropTarget = $state<string | null>(null);

	function handleDragStart(e: DragEvent, instanceId: string) {
		dragInstanceId = instanceId;
		e.dataTransfer!.effectAllowed = "move";
		e.dataTransfer!.setData("text/plain", instanceId);
	}

	function handleDragOver(e: DragEvent, dateStr: string) {
		e.preventDefault();
		e.dataTransfer!.dropEffect = "move";
		dropTarget = dateStr;
	}

	function handleDrop(e: DragEvent, dateStr: string) {
		e.preventDefault();
		const id = e.dataTransfer?.getData("text/plain") || dragInstanceId;
		if (id) onDrop(id, dateStr);
		dragInstanceId = null;
		dropTarget = null;
	}

	function handleDragEnd() {
		dragInstanceId = null;
		dropTarget = null;
	}
</script>

<div class="flex flex-1 flex-col overflow-hidden select-none">
	<!-- Day headers -->
	<div class="flex border-b border-surface-200-800 bg-surface-50-950">
		<div class="w-8 shrink-0 border-r border-surface-200-800" />
		<div class="flex-1 grid grid-cols-7">
			{#each dayLabels as day}
				<div class="py-1 text-center text-xs font-medium text-surface-500-400">{day}</div>
			{/each}
		</div>
	</div>

	<!-- Grid rows: 6 weeks -->
	<div class="flex-1 flex flex-col overflow-hidden">
		{#each weeks as week, wi (wi)}
			<div class="flex flex-1 border-b border-surface-200-800 overflow-hidden">
				<!-- Week number column -->
				<div
					class="w-8 shrink-0 border-r border-surface-200-800 flex items-start justify-center pt-1 cursor-pointer hover:bg-surface-50-950"
					ondblclick={() => onWeekDblClick(toDateStr(week[0]))}
					role="button"
					title="Show week"
				>
					<span class="text-xs text-surface-400-600">{getISOWeekNumber(week[0])}</span>
				</div>
				<!-- 7 day cells -->
				<div class="flex-1 grid grid-cols-7 overflow-hidden">
					{#each week as day (toDateStr(day))}
						{@const dateStr = toDateStr(day)}
						{@const dayInstances = instancesByDate.get(dateStr) ?? []}
						{@const isCurrentMonth = day.getMonth() === currentMonthNum}
						{@const isToday = dateStr === today}
						{@const isDropTarget = dropTarget === dateStr}

						<div
							class="border-r border-surface-200-800 p-1 overflow-hidden flex flex-col gap-0.5
								{isCurrentMonth ? '' : 'opacity-40'}
								{isDropTarget ? 'bg-primary-50 dark:bg-primary-950' : 'hover:bg-surface-50-950'}"
							ondragover={(e) => handleDragOver(e, dateStr)}
							ondrop={(e) => handleDrop(e, dateStr)}
							ondblclick={() => onDayDblClick(dateStr)}
							role="gridcell"
						>
							<!-- Day number -->
							<button
								onclick={() => onDayClick(dateStr)}
								class="flex size-6 items-center justify-center self-start rounded-full text-xs font-medium
									{isToday ? 'bg-primary-500 text-white' : 'hover:bg-surface-200-800 text-surface-700-300'}"
							>{day.getDate()}</button>

							<!-- Events -->
							{#each dayInstances.slice(0, MAX_VISIBLE_EVENTS) as inst (inst.instanceId)}
								<button
									draggable="true"
									ondragstart={(e) => handleDragStart(e, inst.instanceId)}
									ondragend={handleDragEnd}
									onclick={(e) => handleEventClick(inst, e)}

									class="w-full truncate rounded px-1 py-0.5 text-left text-xs text-white font-medium hover:opacity-80 transition-opacity"
									style="background-color: {inst.color};"
								>
									{#if !inst.isAllDay}
										<span class="opacity-80">{formatTime(inst.startISO, displayTzid)}</span>
									{/if}
									{inst.summary}
								</button>
							{/each}

							{#if dayInstances.length > MAX_VISIBLE_EVENTS}
								<button
									onclick={() => onDayClick(dateStr)}
									class="text-left text-xs text-surface-500-400 hover:text-surface-700-300 px-1"
								>+{dayInstances.length - MAX_VISIBLE_EVENTS} more</button>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
